export const SUPPORTED_DOMAINS = [
  'instagram.com', 'x.com', 'twitter.com', 'tiktok.com', 'facebook.com',
  'fb.watch', 'youtube.com', 'youtu.be', 'reddit.com', 'threads.net', 'pinterest.com'
] as const;

export function isSupportedUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return SUPPORTED_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`)) ? url : null;
  } catch {
    return null;
  }
}
