"""Add three adjustable local joints to each published actor, preserving its original bind pose."""
import argparse
from collections import deque
import json
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation


# Measured centre lines in the two original meshes, in metres and glTF coordinates.
# The three pivots follow the root, middle and distal segment. The final sample sets the tip axis.
RIGS = {
    'zhenfu': {
        'parent': 'mixamorig:Hips', 'prefix': 'ZF', 'primitive': 3, 'joint_count': 118,
        'line': [[0, .988, .086], [0, 1.002, .117], [-.001, 1.014, .153],
                 [-.003, 1.0365, .199], [-.005, 1.051, .2349]],
        'pivots': [0, 2, 3], 'radius': [.039, .034], 'root_blend': .030, 'blend': .018,
    },
    'leon': {
        'parent': 'hips', 'prefix': 'Leon', 'primitive': 0, 'joint_count': 404,
        'line': [[0, .932, .108], [0, .932, .145], [.001, .947, .190],
                 [.003, .967, .248], [.006, .979, .2947]],
        'pivots': [0, 2, 3], 'radius': [.040, .035], 'root_blend': .041, 'blend': .023,
    },
}
TYPES = {5121: 'u1', 5123: '<u2', 5125: '<u4', 5126: '<f4'}
WIDTH = {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def array(doc, buffers, index):
    a = doc['accessors'][index]
    v = doc['bufferViews'][a['bufferView']]
    dtype = np.dtype(TYPES[a['componentType']])
    width = WIDTH[a['type']]
    return np.ndarray((a['count'], width), dtype, buffers[v['buffer']],
                      v.get('byteOffset', 0) + a.get('byteOffset', 0),
                      (v.get('byteStride', dtype.itemsize * width), dtype.itemsize))


def local_matrix(n):
    if 'matrix' in n:
        return np.array(n['matrix']).reshape(4, 4, order='F')
    m = np.eye(4)
    m[:3, :3] = Rotation.from_quat(n.get('rotation', [0, 0, 0, 1])).as_matrix() @ np.diag(n.get('scale', [1]*3))
    m[:3, 3] = n.get('translation', [0, 0, 0])
    return m


def smooth(start, stop, x):
    t = np.clip((x - start) / (stop - start), 0., 1.)
    return t * t * (3 - 2 * t)


def tip_component(pos, triangles, candidate):
    # Weld only for the selection. Keep every original vertex, UV seam and morph target in the asset.
    _, ids = np.unique(pos.round(5), axis=0, return_inverse=True)
    ids = ids.reshape(-1)
    active = set(ids[candidate].tolist())
    graph = {v: set() for v in active}
    for tri in ids[triangles[np.any(candidate[triangles], axis=1)]]:
        for a, b in ((tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])):
            if a in active and b in active:
                graph[a].add(b)
                graph[b].add(a)
    seed = ids[np.where(candidate)[0][np.argmax(pos[candidate, 2])]]
    seen = {seed}
    queue = deque([seed])
    while queue:
        for v in graph[queue.popleft()] - seen:
            seen.add(v)
            queue.append(v)
    return np.isin(ids, list(seen))


def add_controls(folder, actor):
    source = folder / 'actor.gltf'
    doc = json.loads(source.read_bytes())
    cfg = RIGS[actor]
    names = [cfg['prefix'] + '_Penis_' + part for part in ('Root', 'Mid', 'Tip')]
    skin = doc['skins'][0]
    base_count = cfg['joint_count']
    if len(skin['joints']) == base_count + len(names):
        if [doc['nodes'][j]['name'] for j in skin['joints'][-3:]] != names or not (folder/'controls.bin').is_file():
            raise ValueError('Incomplete or incompatible extended rig: ' + actor)
        return
    if len(skin['joints']) != base_count:
        raise ValueError('Unexpected source rig: ' + actor)
    buffers = [(folder / b['uri']).read_bytes() for b in doc['buffers']]
    primitive = doc['meshes'][0]['primitives'][cfg['primitive']]
    attrs = primitive['attributes']
    pos = array(doc, buffers, attrs['POSITION'])
    faces = array(doc, buffers, primitive['indices']).reshape(-1, 3)
    sets = [i for i in (0, 1) if 'JOINTS_' + str(i) in attrs]
    original_j = np.hstack([array(doc, buffers, attrs[f'JOINTS_{i}']) for i in sets])
    original_w = np.hstack([array(doc, buffers, attrs[f'WEIGHTS_{i}']) for i in sets])
    parent_slot = next(i for i, j in enumerate(skin['joints']) if doc['nodes'][j]['name'] == cfg['parent'])
    parent_node = skin['joints'][parent_slot]
    parent_weight = np.sum(np.where(original_j == parent_slot, original_w, 0), axis=1)
    line = np.array(cfg['line'])
    z = pos[:, 2]
    x, y = (np.interp(z, line[:, 2], line[:, axis]) for axis in (0, 1))
    radius = np.hypot((pos[:, 0]-x) / cfg['radius'][0], (pos[:, 1]-y) / cfg['radius'][1])
    root = line[0, 2]
    influence = (smooth(root-.006, root+cfg['root_blend'], z) * (1-smooth(.90, 1.16, radius))
                 * smooth(.86, .995, parent_weight) * (z <= line[-1, 2]+.006))
    influence[influence < 1e-6] = 0
    influence *= tip_component(pos, faces, influence > 0)
    pivots = line[cfg['pivots']]
    h = cfg['blend']
    middle = smooth(pivots[1,2]-h, pivots[1,2]+h, z)
    distal = smooth(pivots[2,2]-h, pivots[2,2]+h, z)
    fractions = np.column_stack((1-middle, middle-distal, distal))
    joints = original_j.copy()
    weights = original_w.copy()
    for vertex in np.flatnonzero(influence):
        influences = zip(original_j[vertex], original_w[vertex])
        retained = [(int(j), float(w)) for j, w in influences if w > 0 and j != parent_slot]
        residual = float(parent_weight[vertex] * (1 - influence[vertex]))
        if residual > 0:
            retained.append((parent_slot, residual))
        for k, share in enumerate(fractions[vertex]):
            transferred = float(parent_weight[vertex] * influence[vertex] * share)
            if transferred > 0:
                retained.append((base_count + k, transferred))
        if len(retained) > joints.shape[1]:
            raise ValueError('Not enough weight slots at a skin boundary')
        retained.sort(key=lambda item: -item[1])
        joints[vertex] = 0
        weights[vertex] = 0
        for slot, (joint, weight) in enumerate(retained):
            joints[vertex, slot] = joint
            weights[vertex, slot] = weight
    if not np.allclose(weights.sum(axis=1), original_w.sum(axis=1), atol=2e-6):
        raise ValueError('Skin weights lost normalization')
    for k in range(3):
        if np.count_nonzero((joints==base_count+k)&(weights>.25))<12:
            raise ValueError('New control has no usable weighted influence')
    binary = bytearray()

    def append(values, kind, component):
        binary.extend(b'\0' * (-len(binary) % 4))
        data = np.asarray(values, dtype=TYPES[component]).tobytes()
        view_index = len(doc['bufferViews'])
        doc['bufferViews'].append({
            'buffer': len(buffers), 'byteOffset': len(binary), 'byteLength': len(data),
        })
        binary.extend(data)
        doc['accessors'].append({
            'bufferView': view_index, 'componentType': component, 'type': kind, 'count': len(values),
        })
        return len(doc['accessors']) - 1

    for i in sets:
        for prefix, values in [('JOINTS', joints), ('WEIGHTS', weights)]:
            key = f'{prefix}_{i}'
            component = doc['accessors'][attrs[key]]['componentType']
            attrs[key] = append(values[:, 4*i:4*i+4], 'VEC4', component)

    parents = {child: i for i, node in enumerate(doc['nodes']) for child in node.get('children', [])}
    hip_world = local_matrix(doc['nodes'][parent_node])
    ancestor = parent_node
    while ancestor in parents:
        ancestor = parents[ancestor]
        hip_world = local_matrix(doc['nodes'][ancestor]) @ hip_world
    inverse_binds = array(doc, buffers, skin['inverseBindMatrices']).copy()
    hip_bind = inverse_binds[parent_slot].reshape(4, 4, order='F')
    rows = list(inverse_binds)
    previous_world = hip_world
    previous_node = parent_node
    for i, pivot in enumerate(pivots):
        end = pivots[i+1] if i+1 < len(pivots) else line[-1]
        forward = end - pivot
        forward /= np.linalg.norm(forward)
        right = np.cross([0, 1, 0], forward)
        right /= np.linalg.norm(right)
        world = np.eye(4)
        world[:3, :3] = np.column_stack((right, np.cross(forward, right), forward))
        world[:3, 3] = pivot
        # Zhenfu's original scene carries a uniform scale above both skin and mesh.
        world = hip_world @ hip_bind @ world
        local = np.linalg.solve(previous_world, world)
        rotation = local[:3, :3]
        if not np.allclose(rotation.T @ rotation, np.eye(3), atol=1e-4):
            raise ValueError('Unexpected scale in pelvis hierarchy')
        index = len(doc['nodes'])
        doc['nodes'][previous_node].setdefault('children', []).append(index)
        doc['nodes'].append({
            'name': names[i], 'translation': local[:3, 3].tolist(),
            'rotation': Rotation.from_matrix(rotation).as_quat().tolist(),
        })
        skin['joints'].append(index)
        rows.append(np.linalg.solve(world, hip_world @ hip_bind).flatten(order='F'))
        previous_world = world
        previous_node = index
    skin['inverseBindMatrices'] = append(rows, 'MAT4', 5126)
    doc['buffers'].append({'uri': 'controls.bin', 'byteLength': len(binary)})
    (folder / 'controls.bin').write_bytes(binary)
    temporary = source.with_suffix('.tmp')
    temporary.write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')))
    temporary.replace(source)
    print(actor, len(skin['joints']), 'joints;', np.count_nonzero(influence), 'weighted vertices', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('models', type=Path)
    root = parser.parse_args().models
    for model in RIGS:
        add_controls(root / model, model)
