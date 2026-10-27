/**
 * 简历 Markdown 的唯一格式说明：提示词与新建简历的 starter 都从这里取。
 *
 * 这里只定义「语法 + 语义」，不定义颜色 / 字号 / 间距——外观全部在渲染层的
 * `components/document/templates/*.css`（一个 CSS 文件 = 一套主题）。改语法时同步改
 * `src/renderer/src/markdown/render.ts` 与主题 CSS，三处必须一致。
 */
export const RESUME_FORMAT = `简历正文是纯 Markdown（GFM），渲染器只认下面这些语法；外观由主题 CSS 决定，不要在正文里写颜色、字号、间距等样式。

- 顶部信息区：用 HTML <table> 排两列，一格一条。首行左格放姓名（<td style="font-size: 1.8em;"><strong>姓名</strong></td>），右格放求职意向；后面依次放经验年限 / 电话 / 邮箱 / 城市 / 链接。表内不要空行。
- 章节标题：### ==章节名==（三级标题 + == 高亮，== 不能省略）。
- 章节之间用 <hr/> 分隔。
- 条目行：#### A | B | C（2~3 段，竖线分段，预览两端对齐；只有时间段时写成两段）。
- 标题两端对齐：#### 标题:::日期（标题里出现 ::: 时按左右两段排，::: 优先于 |）。
- 普通行两端对齐：左边:::右边（一行一条，::: 前后各自写行内 Markdown；左边或右边可以为空）。
- 图标：icon:github（行内任意位置可用，正文和顶部表格都行）。常用：mail / phone / map-pin / globe / link / calendar / clock / github / linkedin / wechat / zhihu / bilibili / x / telegram / youtube / code / database / cloud / briefcase / graduation-cap / award / star。未知名字原样显示。
- 照片（可选）：文档第一行写 photo: upload/文件名。照片位置由主题决定（当前模板放在右上角，与信息表并排），不要自己写 <img>；只有 upload/ 里确实有这张图时才写。
- 条目内容用无序列表分点；关键技能 **加粗**，最亮眼的成果可用 ==高亮==。
- 除顶部信息表外不要写别的 HTML；不放正文图片（照片只用 photo: 指令）。
- 章节顺序按用户情况调整，常用：基本信息（表格）/ 专业技能 / 工作经历 / 项目经历 / 教育背景 / 获奖与其他。`;

/** 新建简历时的空骨架：与 RESUME_FORMAT 使用同一套语法，避免新文件一出生就跑偏。 */
export const RESUME_STARTER = `<table>
<tr><td style="font-size: 1.8em;"><strong>姓名</strong></td><td>求职意向：</td></tr>
<tr><td>icon:phone 电话：</td><td>icon:mail 邮箱：</td></tr>
<tr><td>icon:map-pin 城市：</td><td>icon:calendar 工作年限：</td></tr>
</table>

<hr/>

### ==专业技能==

- （待补充）

<hr/>

### ==工作经历==

#### 公司 | 职位 | 时间

- （待补充）

<hr/>

### ==项目经历==

#### 项目名:::时间

- （待补充）

<hr/>

### ==教育背景==

#### 学校 | 专业 | 时间

- （待补充）

<hr/>

### ==获奖与其他==

- （待补充）
`;
