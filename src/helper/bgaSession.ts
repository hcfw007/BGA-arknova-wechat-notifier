import { AxiosInstance } from "axios"
import { mergeCookies } from "./cookie"

export interface BgaCredentials {
  cookie: string
  token: string
}

/**
 * BGA 的 ajax 接口都要一个从页面里刮出来的 requestToken，且必须与 cookie 属于同一会话。
 * 实测缺 token 的请求会让整个会话失效（之后带正确 token 也报 806），所以调用方必须保证每次都带上。
 */
export async function handshake(
  http: AxiosInstance,
  pageUrl: string,
  baseCookie?: string,
): Promise<BgaCredentials> {
  const res = await http.get(pageUrl, baseCookie ? { headers: { Cookie: baseCookie } } : undefined)

  const setCookie = ((res.headers['set-cookie'] ?? []) as string[])
    .map(c => c.split(';')[0])
    .join('; ')
  const cookie = mergeCookies(baseCookie, setCookie)

  const tokenMatch = (res.data as string).match(/requestToken['":,\s]+([a-f0-9]{64})/)
  if (!tokenMatch) {
    throw new Error(`could not extract requestToken from ${pageUrl}`)
  }

  return { cookie, token: tokenMatch[1] }
}
