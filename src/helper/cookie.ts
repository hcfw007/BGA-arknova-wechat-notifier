/**
 * 按 cookie 名合并，后来的覆盖先前的。
 * BGA 每次握手都会重发 PHPSESSID，直接字符串拼接会让同名 cookie 无限堆积。
 */
export function mergeCookies(base: string | undefined, incoming: string | undefined): string {
  const jar = new Map<string, string>()
  for (const source of [base, incoming]) {
    for (const raw of (source ?? '').split(';')) {
      // 先 trim 再定位 '='，否则 " =novalue" 会被当成合法条目，塞进一个空名 cookie
      const pair = raw.trim()
      const idx = pair.indexOf('=')
      if (idx > 0) {
        jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim())
      }
    }
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
}
