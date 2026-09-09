# Spine Viewer

Spine Viewer lets users inspect and interactively preview locally supplied Spine animation assets.

## Language

**Spine resource bundle**:
A complete, locally selected preview unit containing one skeleton file (`.json` or `.skel`), one texture atlas (`.atlas`), and every texture image referenced by that atlas.
_Avoid_: Spine file, animation file, upload file

**Event frame**:
One occurrence of an event in the currently selected animation, identified by its time and event data. Repeated events with the same name are separate event frames.
_Avoid_: Event type, global event
