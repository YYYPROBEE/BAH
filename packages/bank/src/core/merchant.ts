/**
 * 商户品类词典（账单场景收口 01 · T-01）。
 *
 * **为什么独立维度**：`TxnCategory` 是**账务分类**（决定记哪本账），品类是**叙事维度**
 * （决定怎么讲账单）。把品类塞进 `TxnCategory` 会连带穷尽标签表（`presenters.ts`
 * `CATEGORY_LABEL`）、工具入参白名单与 25 条快照文案——改动面发散，语义也不对。
 *
 * 匹配是**确定性**的：精确表 → 关键词表（长的先匹配）→ `other`。不猜、不调模型。
 * 于是"分类准确率"这个问题不存在，存在的是**覆盖率**（当前 demo 商户 100% 命中）。
 */

/** 商户品类（9 值穷尽；`other` 是兜底，绝不做隐式猜测）。 */
export type MerchantCategory =
  | 'dining'
  | 'coffee'
  | 'grocery'
  | 'transit'
  | 'shopping'
  | 'digital'
  | 'transfer'
  | 'salary'
  | 'other'

/** 品类文案（穷尽表：漏一个编译失败——这是护栏，不是负担）。 */
export const MERCHANT_LABEL: Readonly<Record<MerchantCategory, string>> = {
  dining: '餐饮',
  coffee: '咖啡',
  grocery: '生鲜',
  transit: '通勤',
  shopping: '购物',
  digital: '数码/订阅',
  transfer: '转账',
  salary: '工资',
  other: '其他',
}

/** 全部品类键（运行时封闭校验用：卡限制的 `value` 只允许这些值）。 */
export const MERCHANT_CATEGORIES: readonly MerchantCategory[] = [
  'dining',
  'coffee',
  'grocery',
  'transit',
  'shopping',
  'digital',
  'transfer',
  'salary',
  'other',
]

/** 字符串是否为合法品类键（卡限制写入面的运行时校验）。 */
export function isMerchantCategory(value: string): value is MerchantCategory {
  return (MERCHANT_CATEGORIES as readonly string[]).includes(value)
}

/**
 * 精确表：全名命中即返回。
 *
 * 只收 demo 与常见真实商户；表里没有的走关键词层，再不命中就是 `other`。
 */
const EXACT: Readonly<Record<string, MerchantCategory>> = {
  盒马鲜生: 'grocery',
  永辉超市: 'grocery',
  叮咚买菜: 'grocery',
  瑞幸咖啡: 'coffee',
  星巴克: 'coffee',
  manner咖啡: 'coffee',
  海底捞: 'dining',
  美团外卖: 'dining',
  麦当劳: 'dining',
  地铁出行: 'transit',
  滴滴出行: 'transit',
  国美电器: 'shopping',
  京东商城: 'shopping',
  淘宝: 'shopping',
  视频会员: 'digital',
  云音乐: 'digital',
  中国移动: 'digital',
  工资代发: 'salary',
}

/**
 * 关键词表：`[关键词, 品类]`，**按长度降序**匹配。
 *
 * 顺序即优先级：`瑞幸咖啡` 若走关键词，"咖啡"（coffee）与"瑞幸"（coffee）都指向同一类；
 * 但"美团外卖"必须先命中"外卖"（dining）而不是"美团"（若将来加了美团买菜，长的先赢）。
 */
const KEYWORD_LIST: readonly (readonly [string, MerchantCategory])[] = [
  ['瑞幸', 'coffee'],
  ['星巴克', 'coffee'],
  ['咖啡', 'coffee'],
  ['外卖', 'dining'],
  ['蛋糕', 'dining'],
  ['餐饮', 'dining'],
  ['生鲜', 'grocery'],
  ['超市', 'grocery'],
  ['买菜', 'grocery'],
  ['地铁', 'transit'],
  ['公交', 'transit'],
  ['打车', 'transit'],
  ['滴滴', 'transit'],
  ['高铁', 'transit'],
  ['电器', 'shopping'],
  ['家电', 'shopping'],
  ['视频', 'digital'],
  ['会员', 'digital'],
  ['音乐', 'digital'],
  ['话费', 'digital'],
  ['移动', 'digital'],
  ['电信', 'digital'],
  ['联通', 'digital'],
  ['工资', 'salary'],
  ['代发', 'salary'],
]

/** 长度降序：长的关键词先匹配（"外卖"先于"美团"这类短词）。 */
const KEYWORDS = [...KEYWORD_LIST].sort((left, right) => right[0].length - left[0].length)

/**
 * 商户名 → 品类。
 *
 * 只吃名字、不猜身份：转账 / 工资这类**由账务分类决定**的行，由调用方用
 * `txn.category` 覆盖（见 `queries.ts` 的 `merchantCategoryOfTxn`），否则
 * "王建国 800 元"会被归进 `other`。
 */
export function merchantCategoryOf(name: string): MerchantCategory {
  const text = name.trim().toLowerCase()
  if (text.length === 0) return 'other'

  const exact = EXACT[text]
  if (exact !== undefined) return exact

  for (const [keyword, category] of KEYWORDS) {
    if (text.includes(keyword)) return category
  }
  return 'other'
}
