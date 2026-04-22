export function getInitials(name?: string | null): string {
  if (!name) return "";
  const cleaned = name.replace(/\(.*?\)/g, " ").replace(/[^\p{L}\s]/gu, " ");
  const words = cleaned.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  return (words[0][0] + (words[1]?.[0] ?? "")).toUpperCase();
}

const AVATAR_TONES = [
  "bg-avatar-1",
  "bg-avatar-2",
  "bg-avatar-3",
  "bg-avatar-4",
  "bg-avatar-5",
] as const;

export function getAvatarTone(seed?: string | null): string {
  if (!seed) return AVATAR_TONES[0];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length];
}
