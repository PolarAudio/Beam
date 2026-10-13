# Draco decoder

The decoder `DRACOLoader` fetches at runtime for glTF models compressed with
`KHR_draco_mesh_compression`. Copied unchanged from
`node_modules/three/examples/jsm/libs/draco/gltf/` at three r170.

| file | purpose |
|---|---|
| `draco_wasm_wrapper.js` | loads the WebAssembly decoder |
| `draco_decoder.wasm` | the decoder |
| `draco_decoder.js` | fallback without WebAssembly |

`draco_encoder.js` is left out; nothing in Beam compresses a model.

`public/` is copied into the renderer output, so this folder is served by the
dev server in development and over `static://` in a packaged build. The two
callers (`scene_objects.js`, `model_instancer.js`) prefix the path with
`VITE_STATIC_URL`.

When three is upgraded, replace the three files from the same folder in
`node_modules`. Do not edit them.
