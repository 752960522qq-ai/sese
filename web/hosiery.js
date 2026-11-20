import * as T from './vendor/three.module.min.js';

// The knit is shaded on the corrected, skinned leg itself. Knee morphs and the
// stocking therefore share every silhouette vertex, including on the raised foot.
export function fitHosiery(actor, mesh, fabric, band, enabled) {
  actor.legMaterials ??= new Map();
  let pair=actor.legMaterials.get(mesh);
  if (!pair && enabled) {
    const skin=mesh.material, dressed=skin.clone();
    dressed.userData.fittedHosiery=true;
    dressed.customProgramCacheKey=()=> 'sese-fitted-knit-v2';
    dressed.normalMap=fabric.normalMap;
    dressed.normalScale.copy(fabric.normalScale);
    dressed.onBeforeCompile=shader=>{
      Object.assign(shader.uniforms,{
        knitMap:{value:fabric.map},knitRM:{value:fabric.roughnessMap},
        knitColor:{value:fabric.color},bandColor:{value:band.color},
        knitAlpha:{value:fabric.opacity},bandAlpha:{value:band.opacity},
        knitSpecularScale:{value:fabric.specularIntensity/(skin.specularIntensity||1)}
      });
      shader.vertexShader=shader.vertexShader.replace('#include <common>',
        '#include <common>\nattribute vec4 _hosiery; varying vec4 vKnit;')
        .replace('#include <uv_vertex>','#include <uv_vertex>\nvKnit = _hosiery;\n#ifdef USE_NORMALMAP\nvNormalMapUv = _hosiery.xy;\n#endif');
      shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`
        #include <common>
        varying vec4 vKnit;
        uniform sampler2D knitMap, knitRM;
        uniform vec3 knitColor, bandColor;
        uniform float knitAlpha, bandAlpha, knitSpecularScale;`)
        .replace('#include <color_fragment>',`#include <color_fragment>
          float coverage = smoothstep(-0.00065, 0.00065, vKnit.z);
          float band = smoothstep(-0.00065, 0.00065, vKnit.w);
          vec4 weave = texture2D(knitMap, vKnit.xy);
          float opacityKnit = coverage * mix(knitAlpha,bandAlpha,band) * weave.a;
          // Convert the source fabric's display-space transparency for the linear, single-pass shade.
          float yarn = 1.0 - pow(max(0.0,1.0-opacityKnit),2.2);
          diffuseColor.rgb = mix(diffuseColor.rgb, weave.rgb * mix(knitColor,bandColor,band), yarn);`)
        .replace('#include <roughnessmap_fragment>',`#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, mix(0.74,0.78,band) * texture2D(knitRM,vKnit.xy).g, yarn);`)
        .replace('#include <lights_physical_fragment>',`#include <lights_physical_fragment>
          material.specularColor *= mix(1.0,knitSpecularScale,yarn);
          #ifdef USE_SHEEN
            material.sheenColor *= 1.0-yarn;
          #endif`)
        .replace('#include <normal_fragment_maps>',T.ShaderChunk.normal_fragment_maps.replace('mapN.xy *= normalScale;', 'mapN.xy *= normalScale * coverage;'));
    };
    pair={skin,dressed};actor.legMaterials.set(mesh,pair);
  }
  if(pair)mesh.material=enabled?pair.dressed:pair.skin;
}
export function disposeHosiery(actor) {
  for(const [mesh,pair] of actor.legMaterials||[]){mesh.material=pair.skin;pair.dressed.dispose();}
  actor.legMaterials?.clear();
}
