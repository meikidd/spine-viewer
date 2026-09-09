# Use the low-level Spine WebGL 3.8 runtime

The viewer supports assets exported by Spine 3.8.20–3.8.x, so its runtime must match that format. We vendor a pinned official `spine-webgl` 3.8 build and implement controls in React instead of wrapping the old `SpinePlayer`: the low-level asset manager can reliably dispose textures during repeated local uploads, and custom rendering gives deterministic seeking plus event-marker control that the built-in player does not expose.
