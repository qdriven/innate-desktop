import { describe, expect, it } from 'vitest'
import {
  BROWSER_EXTRACTION_BUDGET,
  BROWSER_EXTRACTION_CDP_METHODS,
  BROWSER_SAFE_ATTRIBUTE_NAMES,
  BROWSER_SECRET_PATTERNS,
  clampElementDetail,
  clampElementSummary,
  clampExtractedAttributes,
  clampExtractedRect,
  clampText,
  containsSecretPattern,
  isAllowedExtractionCdpMethod,
  makeElementRef,
  parseElementRef,
  parseExtractionDetailRequest,
  parseExtractionListRequest,
  sanitizeExtractedUrl,
} from './extraction.js'

describe('sanitizeExtractedUrl（W6 提取结果 URL 净化）', () => {
  it('http/https 保留 origin+path，剥除 query 与 hash', () => {
    expect(sanitizeExtractedUrl('https://example.com/a/b?token=secret#frag'))
      .toBe('https://example.com/a/b')
    expect(sanitizeExtractedUrl('http://example.com/')).toBe('http://example.com/')
  })

  it('非 http/https 与非法 URL 一律清空（认证 URL 不进提取结果）', () => {
    expect(sanitizeExtractedUrl('file:///C:/secret')).toBe('')
    expect(sanitizeExtractedUrl('javascript:alert(1)')).toBe('')
    expect(sanitizeExtractedUrl('not a url')).toBe('')
    expect(sanitizeExtractedUrl(undefined)).toBe('')
  })
})

describe('clampExtractedAttributes（W6 属性白名单 + 脱敏）', () => {
  it('只保留白名单属性与 aria-*，其余丢弃', () => {
    const filtered = clampExtractedAttributes({
      id: 'submit',
      class: 'btn primary',
      role: 'button',
      title: '提交',
      'aria-label': '提交表单',
      onclick: 'doSomething()',
      'data-secret-ish': 'x',
    })
    expect(Object.keys(filtered).sort()).toEqual(
      ['aria-label', 'class', 'id', 'role', 'title'].sort(),
    )
  })

  it('凭据形态的值替换为 [redacted]', () => {
    const filtered = clampExtractedAttributes({
      title: 'api_key=abcdef123456',
      id: 'session_id-99',
    })
    expect(filtered.title).toBe('[redacted]')
    expect(filtered.id).toBe('[redacted]')
  })

  it('href/action 走 URL 净化（剥 query 与 hash）', () => {
    const filtered = clampExtractedAttributes({
      href: 'https://example.com/x?page=2#h',
      action: 'https://example.com/post',
    })
    expect(filtered.href).toBe('https://example.com/x')
    expect(filtered.action).toBe('https://example.com/post')
  })

  it('URL 命中凭据形态时整体脱敏（先脱敏后净化）', () => {
    const filtered = clampExtractedAttributes({
      href: 'https://example.com/x?access_token=1',
    })
    expect(filtered.href).toBe('[redacted]')
  })

  it('class 更严的长度上限；属性条目数有上限', () => {
    const longClass = 'c'.repeat(500)
    expect(clampExtractedAttributes({ class: longClass }).class?.length)
      .toBeLessThanOrEqual(BROWSER_EXTRACTION_BUDGET.classValueMaxLength + ' (truncated)'.length)
    const many: Record<string, string> = {}
    for (let i = 0; i < 60; i += 1) many[`data-x${i}`] = 'v'
    expect(Object.keys(clampExtractedAttributes(many)).length)
      .toBeLessThanOrEqual(BROWSER_EXTRACTION_BUDGET.attributeMaxEntries)
  })

  it('脱敏关键字表覆盖常见凭据形态', () => {
    for (const pattern of ['access_token', 'client_secret', 'csrf', 'password']) {
      expect(BROWSER_SECRET_PATTERNS).toContain(pattern)
      expect(containsSecretPattern(`xx${pattern}yy`)).toBe(true)
    }
    // 宽泛词不做匹配（避免误伤普通 class）
    expect(containsSecretPattern('code-style')).toBe(false)
    expect(containsSecretPattern('state-city')).toBe(false)
  })
})

describe('CDP 方法白名单（W6 红线）', () => {
  it('只含只读 DOM/Accessibility/Page 方法', () => {
    for (const method of BROWSER_EXTRACTION_CDP_METHODS) {
      expect(method).toMatch(/^(DOM|Accessibility|Page)\./)
    }
  })

  it('不含任何可执行页面脚本的方法（Runtime.*）', () => {
    for (const method of BROWSER_EXTRACTION_CDP_METHODS) {
      expect(method.startsWith('Runtime.')).toBe(false)
    }
    expect(isAllowedExtractionCdpMethod('Runtime.evaluate')).toBe(false)
    expect(isAllowedExtractionCdpMethod('Page.navigate')).toBe(false)
    expect(isAllowedExtractionCdpMethod('Input.dispatchKeyEvent')).toBe(false)
    expect(isAllowedExtractionCdpMethod('DOM.getBoxModel')).toBe(true)
  })
})

describe('元素引用（W6 不透明 ref）', () => {
  it('makeElementRef / parseElementRef 互逆', () => {
    expect(makeElementRef(1)).toBe('el-1')
    expect(parseElementRef('el-1')).toBe(1)
    expect(parseElementRef('el-0')).toBeNull()
    expect(parseElementRef('el-abc')).toBeNull()
    expect(parseElementRef('1')).toBeNull()
    expect(parseElementRef(1)).toBeNull()
  })
})

describe('parseExtractionListRequest（W6 清单条数上限）', () => {
  it('缺省/非法输入回落到默认条数', () => {
    expect(parseExtractionListRequest(undefined).limit).toBe(BROWSER_EXTRACTION_BUDGET.defaultElementLimit)
    expect(parseExtractionListRequest({}).limit).toBe(BROWSER_EXTRACTION_BUDGET.defaultElementLimit)
    expect(parseExtractionListRequest({ limit: 'x' }).limit).toBe(BROWSER_EXTRACTION_BUDGET.defaultElementLimit)
    expect(parseExtractionListRequest({ limit: Number.NaN }).limit).toBe(BROWSER_EXTRACTION_BUDGET.defaultElementLimit)
  })

  it('条数夹到 [1, 上限]', () => {
    expect(parseExtractionListRequest({ limit: 0 }).limit).toBe(1)
    expect(parseExtractionListRequest({ limit: -5 }).limit).toBe(1)
    expect(parseExtractionListRequest({ limit: 10 }).limit).toBe(10)
    expect(parseExtractionListRequest({ limit: 9999 }).limit).toBe(BROWSER_EXTRACTION_BUDGET.elementMaxEntries)
  })
})

describe('parseExtractionDetailRequest（W6 详情引用校验）', () => {
  it('合法 ref 通过', () => {
    expect(parseExtractionDetailRequest({ ref: 'el-3' })).toEqual({ ref: 'el-3' })
  })

  it('非法 ref 抛错（renderer 不能自造 id）', () => {
    expect(() => parseExtractionDetailRequest({ ref: 'el-x' })).toThrow(/ref 无效/)
    expect(() => parseExtractionDetailRequest({ ref: 'el-0' })).toThrow(/ref 无效/)
    expect(() => parseExtractionDetailRequest({})).toThrow(/ref 必须是字符串/)
    expect(() => parseExtractionDetailRequest(null)).toThrow(/ref 必须是字符串/)
  })
})

describe('clampElementSummary / clampElementDetail（W6 结果钳制）', () => {
  it('摘要缺字段时补空串；全空视为无效', () => {
    expect(clampElementSummary({ role: 'button' })).toMatchObject({ role: 'button', name: '', tagName: '' })
    expect(clampElementSummary({})).toBeNull()
    expect(clampElementSummary(null)).toBeNull()
  })

  it('摘要几何非有限数归零', () => {
    const summary = clampElementSummary({ role: 'link', name: 'a', rect: { x: Number.NaN, y: 1, width: 2, height: 3 } })
    expect(summary?.rect).toEqual({ x: 0, y: 1, width: 2, height: 3 })
    expect(clampExtractedRect(undefined)).toBeNull()
  })

  it('详情缺标签名视为无效', () => {
    expect(clampElementDetail({ role: 'button' })).toBeNull()
    expect(clampElementDetail({ tagName: 'button' })).toMatchObject({ tagName: 'button', role: null, name: null })
  })

  it('详情文本与选择器按预算截断', () => {
    const detail = clampElementDetail({
      tagName: 'button',
      textSnippet: 'x'.repeat(500),
      selector: 'y'.repeat(2000),
    })
    expect(detail?.textSnippet.length)
      .toBeLessThanOrEqual(BROWSER_EXTRACTION_BUDGET.textSnippetMaxLength + ' (truncated)'.length)
    expect(detail?.selector?.length)
      .toBeLessThanOrEqual(BROWSER_EXTRACTION_BUDGET.selectorMaxLength + ' (truncated)'.length)
  })

  it('详情属性走同一套白名单与脱敏', () => {
    const detail = clampElementDetail({
      tagName: 'input',
      attributes: { type: 'text', name: 'pwd', onclick: 'x()' },
    })
    expect(detail?.attributes.type).toBe('text')
    expect(detail?.attributes.onclick).toBeUndefined()
  })

  it('属性值命中凭据形态时脱敏（宁可过度脱敏）', () => {
    const detail = clampElementDetail({
      tagName: 'input',
      attributes: { type: 'password' },
    })
    expect(detail?.attributes.type).toBe('[redacted]')
  })

  it('非 PNG 或超预算的截图被丢弃', () => {
    expect(clampElementDetail({
      tagName: 'div',
      screenshot: { dataUrl: 'data:text/html;base64,xxx', width: 1, height: 1 },
    })?.screenshot).toBeUndefined()
    const huge = `data:image/png;base64,${'a'.repeat(BROWSER_EXTRACTION_BUDGET.screenshotMaxBytes + 10)}`
    expect(clampElementDetail({ tagName: 'div', screenshot: { dataUrl: huge, width: 1, height: 1 } })?.screenshot)
      .toBeUndefined()
    const ok = clampElementDetail({
      tagName: 'div',
      screenshot: { dataUrl: 'data:image/png;base64,AAAA', width: 10, height: 20 },
    })
    expect(ok?.screenshot).toEqual({ dataUrl: 'data:image/png;base64,AAAA', width: 10, height: 20 })
  })
})

describe('clampText（W6 文本截断）', () => {
  it('超长文本截断并标记', () => {
    expect(clampText('abc', 10)).toBe('abc')
    expect(clampText('abcdef', 3)).toBe('abc (truncated)')
    expect(clampText(undefined, 3)).toBe('')
  })
})

describe('BROWSER_SAFE_ATTRIBUTE_NAMES（W6 属性白名单）', () => {
  it('不含 src（图片地址常带签名参数），含 aria-* 另行放行', () => {
    expect(BROWSER_SAFE_ATTRIBUTE_NAMES.has('src')).toBe(false)
    expect(BROWSER_SAFE_ATTRIBUTE_NAMES.has('id')).toBe(true)
    expect(BROWSER_SAFE_ATTRIBUTE_NAMES.has('role')).toBe(true)
  })
})
