"""Export the Sit-only cloak corrective for the web.

Run: blender -b studies/cloak-sit-corrective.blend --python scripts/export-model.py
"""

from pathlib import Path

import bpy


root = Path(__file__).resolve().parents[1]
source = root / "studies" / "cloak-sit-corrective.blend"
destination = root / "src" / "mascot.glb"
if Path(bpy.data.filepath).resolve() != source.resolve():
    raise RuntimeError(f"Open {source} before running this exporter")

armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
if len(armatures) != 1:
    raise RuntimeError(f"Expected one armature, found {len(armatures)}")
armature = armatures[0]
meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and obj.parent == armature]
if len(meshes) != 1 or meshes[0].data.name != "Cloak mesh - Sit corrective":
    raise RuntimeError("The Sit-only cloak corrective mesh is not active")
keys = meshes[0].data.shape_keys
if not keys or keys.animation_data.action != bpy.data.actions.get("Armature|sit"):
    raise RuntimeError("Sit cloak shape keys are not bound to the Sit action")

# The saved study retains source actions for editing. Export only the corrected versions.
for name in ("afraid", "bow", "dance_04", "fold_arms", "sit", "walk"):
    original = bpy.data.actions.get(f"Armature|{name}.001")
    if original:
        bpy.data.actions.remove(original)

# Frame zero has no cloak morph, so non-Sit actions keep the original drape.
bpy.context.scene.frame_set(0)

# Keep the full-resolution packed image in the .blend, but use a smaller web texture.
for mesh in meshes:
    for material in mesh.data.materials:
        if material and material.node_tree:
            for node in material.node_tree.nodes:
                if node.type == "TEX_IMAGE" and node.image and max(node.image.size) > 1024:
                    width, height = node.image.size
                    factor = 1024 / max(width, height)
                    node.image.scale(round(width * factor), round(height * factor))

bpy.ops.object.select_all(action="DESELECT")
for obj in [armature, *meshes]:
    obj.select_set(True)
bpy.context.view_layer.objects.active = armature
bpy.ops.export_scene.gltf(
    filepath=str(destination),
    export_format="GLB",
    use_selection=True,
    export_cameras=False,
    export_lights=False,
    export_animation_mode="ACTIONS",
    export_anim_single_armature=True,
    export_frame_range=False,
    export_anim_slide_to_zero=True,
    export_image_format="AUTO",
    export_morph_animation=True,
)

print(f"Exported Sit-only cloak corrective to {destination}")
