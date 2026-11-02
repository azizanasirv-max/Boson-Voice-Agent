/**
 * Register an AudioWorklet module from a source string.
 * Uses a Blob URL for consistent loading across dev and production bundles.
 */
export async function addWorkletModule(
  ctx: BaseAudioContext,
  source: string,
): Promise<void> {
  const blob = new Blob([source], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}
