/**
 * Static vision-capability classification, resolved the moment a model is
 * selected (not reactively after a failed request). Claude and Gemini models we
 * offer are all multimodal; Ollama and OpenRouter are grab-bags where most
 * models have no vision encoder at all, so we match known vision families and
 * default to "unsupported" for everything else.
 *
 * WHY THE DEFAULT IS "NO"
 *
 * The two wrong answers are not symmetrical. Guessing "no vision" when the
 * model can see costs the agent one screenshot and prints a sentence telling it
 * (and the user) exactly what happened and how to fix it. Guessing "yes" when
 * the model cannot see sends an image the provider rejects — and the image is
 * in the conversation by then, so the rejection repeats on every later turn in
 * that thread. Unknown therefore means no.
 */
export function supportsVision(provider: string, model: string): boolean {
  if (provider === 'claude') return true;
  if (provider === 'gemini') return true;
  if (provider === 'ollama') return ollamaNameLooksVision(model);
  if (provider === 'openrouter') return openrouterLooksVision(model);
  return false;
}

/**
 * Name-based heuristic for whether an Ollama model is multimodal. This is only
 * a FALLBACK — the accurate path queries the model's real capabilities via
 * /api/show (see resolveModelVision in ollama.ts). Kept in sync with the
 * frontend copy in useModels.ts. Errs toward including known vision families.
 */
export function ollamaNameLooksVision(model: string): boolean {
  return /llava|bakllava|moondream|minicpm-?v|pixtral|vision|\bvl\b|-vl\b|qwen2?\.?5?-?vl|internvl|cogvlm|llama3\.2.*vision|mllama|gemma3|granite3\.\d+-vision|minimax|\bgpt-4o|\bo3\b|phi-?3\.5?-?vision|phi-?4.*vision/i.test(model);
}

/**
 * Whether an OpenRouter slug names a multimodal model.
 *
 * OpenRouter has no capability probe of the kind Ollama's /api/show gives us,
 * so this reads the slug — which is reliable in practice because the slugs are
 * `vendor/model` and the multimodal families are well known.
 *
 * This function is the fix for a real bug, and the shape of the bug is worth
 * recording. `activeModelSupportsVision` used to answer for OpenRouter by
 * reading the OLLAMA model setting and asking the OLLAMA heuristic about it —
 * a completely unrelated string. So with OpenRouter selected the verdict was
 * whatever happened to be in the Ollama box: usually "no vision" for a model
 * that can see (screenshots silently withheld from GPT-4o), and "yes" whenever
 * that box held a vision model's name, which attached an image to a text-only
 * OpenRouter model and got the whole thread stuck behind a repeating 400. The
 * frontend, meanwhile, answered a blanket `true` for every OpenRouter model, so
 * the composer's "this model can't read images" warning never appeared. Three
 * places, three different answers, none of them the model's.
 */
export function openrouterLooksVision(model: string): boolean {
  const slug = model.toLowerCase();

  // 1. An explicit marker in the name. Decisive, and checked FIRST — an
  //    exclusion rule below nearly shipped a bug where every slug ending in
  //    "-instruct" was called text-only, which is most of the catalogue,
  //    "llama-3.2-90b-vision-instruct" and "qwen2.5-vl-72b-instruct" included.
  if (/vision|pixtral|internvl|kimi-vl|glm-4v|\bvl\b|-vl-|cogvlm/.test(slug)) return true;

  // 2. Vendors whose entire current catalogue on OpenRouter is multimodal.
  if (/^anthropic\/claude-(?!2)/.test(slug)) return true;
  if (/^google\/gemini/.test(slug)) return true;

  // 3. Named text-only members of otherwise-multimodal families.
  if (/gpt-3\.5|gpt-4-0?314|gpt-4-32k/.test(slug)) return false;

  // 4. Multimodal families that carry no marker in the name.
  return /gpt-4o|gpt-4\.1|gpt-4-turbo|chatgpt-4o|\bo[134]\b|o1-|o3-|o4-/.test(slug)
    || /gemma-?3|llama-?3\.2-(11b|90b)|llama-?4|mllama/.test(slug)
    || /grok-[34]/.test(slug);
}
