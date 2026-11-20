"""Index the city mesh triangles without storing their geometry a second time."""
import struct
from pathlib import Path
import numpy as np

CELL=np.array([8,5,8],dtype='f4')

def bake(folder, name, parts):
    if not parts:return None
    ranges=[]
    for triangles,_ in parts:
        low=np.floor(triangles.min(axis=1)/CELL).astype('i4')
        high=np.floor(triangles.max(axis=1)/CELL).astype('i4')
        ranges.append((low,high))
    origin=np.min([lo.min(0) for lo,_ in ranges],axis=0)
    extent=np.max([hi.max(0) for _,hi in ranges],axis=0)-origin+1
    nx,ny,nz=map(int,extent)
    cells=[[] for i in range(nx*ny*nz)]
    start=0
    for low,high in ranges:
        for i,((x,y,z),(xx,yy,zz)) in enumerate(zip((low-origin).tolist(),(high-origin).tolist())):
            for k in range(z,zz+1):
                for j in range(y,yy+1):
                    row=(k*ny+j)*nx
                    for col in range(x,xx+1):cells[row+col].append(start+i)
        start+=len(low)
    offsets=np.cumsum([0,*map(len,cells)],dtype='<u4')
    refs=np.fromiter((i for cell in cells for i in cell),dtype='<u4',count=int(offsets[-1]))
    path=Path(folder)/(name+'.col')
    with path.open('wb') as f:
        f.write(struct.pack('<4sI3f3i3I2I',b'COL2',2,*CELL,*origin,*extent,len(parts),len(refs)))
        for tris,flags in parts:f.write(struct.pack('<II',len(tris),flags))
        f.write(offsets.tobytes());f.write(refs.tobytes())
    return path.name
