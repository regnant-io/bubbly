/**
 * Static vision-capability classification, resolved the moment a model is
 * selected (not reactively after a failed request). Claude/Gemini models we
 * offer are all multimodal; Ollama is a grab-bag of local models where most
 * text models have no vision encoder at all, so we match known vision model
 * families and default to "unsupported" for everything else.
 */
export function supportsVision(provider: string, model: string): boolean {
  if (provider === 'claude') return true;
  if (provider === 'gemini') return true;
  if (provider === 'ollama') return ollamaNameLooksVision(model);
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
