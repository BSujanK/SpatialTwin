export interface LabelRect { x: number; y: number; w: number; h: number }

export function placeLabel(preferred: LabelRect, occupied: LabelRect[], width: number, height: number): LabelRect {
  const clampX = (x: number) => Math.max(12, Math.min(x, width - preferred.w - 12));
  const clampY = (y: number) => Math.max(98, Math.min(y, height - preferred.h - 45));
  const xs = [clampX(preferred.x), ...occupied.flatMap(rect => [rect.x - preferred.w - 10, rect.x + rect.w + 10]).map(clampX)];
  const ys = [clampY(preferred.y), ...occupied.flatMap(rect => [rect.y - preferred.h - 10, rect.y + rect.h + 10]).map(clampY)];
  const candidates = xs.flatMap(x => ys.map(y => ({ ...preferred, x, y })));
  candidates.sort((a, b) => (Math.abs(a.x - preferred.x) * 2 + Math.abs(a.y - preferred.y)) - (Math.abs(b.x - preferred.x) * 2 + Math.abs(b.y - preferred.y)));
  return candidates.find(candidate => occupied.every(rect => candidate.x + candidate.w + 6 <= rect.x || rect.x + rect.w + 6 <= candidate.x || candidate.y + candidate.h + 6 <= rect.y || rect.y + rect.h + 6 <= candidate.y)) ?? candidates[0];
}
