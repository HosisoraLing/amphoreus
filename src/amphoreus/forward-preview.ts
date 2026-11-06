const decode = (value: unknown) => String(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]*>/g,'')
  .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&')

/** Exact QQ card metadata; never request or summarize the inner forwarded messages. */
export function cardPreview(elements: { arkElement?: { bytesData?: unknown }; multiForwardMsgElement?: Record<string, unknown> }[]) {
  const strings = []
  for (const element of elements ?? []) {
    if (typeof element.arkElement?.bytesData === 'string') strings.push(element.arkElement.bytesData)
    for (const value of Object.values(element.multiForwardMsgElement ?? {})) if (typeof value === 'string') strings.push(value)
  }
  for (const value of strings) {
    try {
      const card = JSON.parse(value), detail = card.meta?.detail
      if (card.app === 'com.tencent.multimsg' && detail) return { title: detail.source || '群聊的聊天记录',
        preview: (detail.news ?? []).slice(0,4).map((line: { text?: string }) => String(line.text ?? '')), summary: detail.summary || '', count: Number(card.extra?.tsum) || undefined }
    } catch { /* QQ also uses an XML card. */ }
    if (value.includes('<msg')) {
      const titles = [...value.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/g)].map(match => decode(match[1]))
      const summary = /<summary\b[^>]*>([\s\S]*?)<\/summary>/.exec(value)
      if (titles.length) return { title: titles[0], preview: titles.slice(1,5), summary: summary ? decode(summary[1]) : '',
        count: Number(/查看\s*(\d+)\s*条/.exec(summary?.[1] ?? '')?.[1]) || undefined }
    }
  }
  return null
}
