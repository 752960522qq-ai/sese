// The RE rig supplies up to eight weights. Three's loader normalizes the first four.
export function useOriginalWeights(scene) {
  const patched = new Map();
  scene.traverse((mesh) => {
    if (!mesh.isSkinnedMesh) return;
    mesh.frustumCulled = false;
    if (!mesh.geometry.getAttribute('weights_1')) return;
    const original = mesh.material;
    if (!patched.has(original)) {
      const material = original.clone();
      material.customProgramCacheKey = () => 'leon-eight-joints-v1';
      material.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
          .replace(
            '#include <skinning_pars_vertex>',
            `#include <skinning_pars_vertex>
#ifdef USE_SKINNING
attribute vec4 joints_1;
attribute vec4 weights_1;
#endif`
          )
          .replace(
            '#include <skinbase_vertex>',
            `#include <skinbase_vertex>
#ifdef USE_SKINNING
float mainWeight = max(0.0, 1.0 - dot(weights_1, vec4(1.0)));
mat4 leonSkin = mainWeight * (skinWeight.x * boneMatX + skinWeight.y * boneMatY
                       + skinWeight.z * boneMatZ + skinWeight.w * boneMatW);
leonSkin += weights_1.x * getBoneMatrix(joints_1.x) + weights_1.y * getBoneMatrix(joints_1.y)
          + weights_1.z * getBoneMatrix(joints_1.z) + weights_1.w * getBoneMatrix(joints_1.w);
mat4 leonSkinLocal = bindMatrixInverse * leonSkin * bindMatrix;
#endif`
          )
          .replace(
            '#include <skinnormal_vertex>',
            `#ifdef USE_SKINNING
objectNormal = (leonSkinLocal * vec4(objectNormal, 0.0)).xyz;
#ifdef USE_TANGENT
objectTangent = (leonSkinLocal * vec4(objectTangent, 0.0)).xyz;
#endif
#endif`
          )
          .replace(
            '#include <skinning_vertex>',
            `#ifdef USE_SKINNING
transformed = (leonSkinLocal * vec4(transformed, 1.0)).xyz;
#endif`
          );
      };
      patched.set(original, material);
    }
    mesh.material = patched.get(original);
  });
}
