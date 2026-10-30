/**
 * @dsh-external/dsh-memo-tuner host half —— 纯载体，无 host 行为。
 *
 * 真正的调参 API/页面由 memo-river 预设插件提供（/memo-river/tuning[/panel]）。
 * 本包存在的唯一原因是 client-modules 只扫 loader entries，而预设插件是 subtree
 * 挂载、进不了 entries —— GUI 侧需要一个独立 entry 承载 client 半面
 * （DESIGN.md §6.6「GUI 卫星包」）。
 *
 * 浏览器侧通过 package.json 的 dsh.client 声明被发现（exports["./client"]）。
 */
export function apply() {}
