# Supplemental Rewriting Rules — Transparency and Subject Extraction

## Scope and precedence

These rules supplement the official Qwen-Image-2.1 rewriting specification that
precedes this file in the same request. They were not written by the Qwen team.
The official specification remains the authority, and where the two disagree the
official specification wins. The output contract is unchanged — still one line of
strict JSON, no markdown fences, no commentary — and so are the language rules,
the ban on quality words, and the rule that ratio and resolution notation never
appears in the prose.

Apply Rule 1 only when the user asks for a transparent or cut-out result, or when
the caller states that transparency is enabled for this request. Apply Rule 2
when the user asks to extract, isolate or cut a subject out of a supplied
photograph. When the user asked for neither, apply nothing from this file: a
request for an ordinary picture must stay an ordinary picture.

## Background — the prompt is the only switch

The model's VAE works in four-channel RGBA space, so every generated image
already carries an alpha channel; an opaque picture and a transparent one are
the same container. There is no output-format parameter and no "transparent
background" flag. Whether the alpha is actually used is decided by the prompt,
and the model accepts an explicit statement of transparency.

## Rule 1 — Transparent (RGBA) output

The model card prescribes one fixed sentence pattern. Reproduce both fixed
clauses verbatim, in English, exactly once, with the scene description as a
complete sentence between them:

    This is an RGBA image with transparency. <scene description>. The image has alpha channel and the background is transparent.

- The middle description must be a complete sentence ending in a period. If it
  runs into the trailing clause, the pattern stops working.
- Never paraphrase or substitute the fixed clauses. "See-through", "no
  background", "isolated on white", "cut-out style" are not equivalents.
- Describe an isolated, self-contained subject: what it is, its material,
  silhouette and surface finish. Then state that nothing surrounds it — no
  scene, no surface, no floor, no horizon, no cast shadow, no container.
- A prompt that still describes surroundings will produce an opaque picture even
  when the pattern is present. "On a white background", "against a seamless
  backdrop", "studio setting", "floating in a soft gradient" are all opaque
  outcomes; never write them here.
- Partial transparency is legitimate and sometimes required: glass, smoke, mesh,
  fur, hair and water may carry soft alpha. Name the material and say its edges
  are soft or partially transparent when that is true.
- Keep transparency in the prose. Do not mention RGBA, alpha channels, bit depth
  or file formats anywhere outside the two fixed clauses.

## Rule 2 — Subject extraction from a photograph

Triggered by requests to extract, cut out, isolate, lift or free a subject from a
supplied photograph (抠图, 提取主体, 抠出来, 去背景, remove the background).

- State that the output contains the isolated subject alone, with the
  photographic background removed completely — not a new scene, not a
  replacement background, not a studio restage.
- Name the subject exactly as it appears in the input image: species or object
  type, garment, material, markings, and any identifying detail that is actually
  present. Never invent detail that is not in the frame.
- Preserve the subject's real proportions, pose, orientation and camera
  viewpoint from the source photograph. Extraction is neither a pose change nor
  a re-shoot.
- Preserve the light falling on the subject, including its direction and colour,
  while removing everything that light fell on behind it. Do not relight it.
- Specify the edge treatment: a clean cut edge with no halo, no fringe of the
  old background, no colour spill and no light wrap.
- For a person or anything with fine structure, state that hair strands, glass
  frames, straps, wires and thin edges survive the cut at full fidelity; a
  coarse silhouette is a failure.
- If the source is a group or a busy scene and the user named one element,
  extract that element only and say so explicitly.
- Add the pattern from Rule 1 around the whole description.
- This is an edit task: reference the input image with `<imageN>` tags as the
  official edit specification requires, and follow its ratio.

## Rule 3 — Where the pattern goes

- Under the t2i specification, the rewritten prompt is a sequence of 15–20
  sentences that begins with an opening frame sentence and ends with a closing
  whole-frame sentence. Put "This is an RGBA image with transparency." at the
  very front, before the opening sentence, and "The image has alpha channel and
  the background is transparent." at the very end, after the closing sentence.
  The official sentence count and word target still apply.
- Under the edit specification, the rewritten prompt is a single dense
  paragraph. Put the first fixed clause at the start of that paragraph and the
  second at its end, keeping every `<imageN>` reference and the ratio fields
  exactly as that specification requires.
- The two fixed clauses are not part of the scene inventory. Do not count them
  as elements of the frame and do not let them displace the description of the
  subject.
