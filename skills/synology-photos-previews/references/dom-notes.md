# Synology Photos 预览重建 · 现场判据与实测数字

本文档记录的是在 **DSM 7.x 共享空间**（`https://<NAS>:<端口>`，Chrome + Synology Image Assistant）上亲自验证过的结果。换版本/换皮肤时先跑 `H.probe()` 重新确认，再批量执行。

## 页面结构与选择器（已验证）

| 用途 | 判据 | 备注 |
| --- | --- | --- |
| SPA 路由 | `#/shared_space/folder/{id}` | 根容器是 `folder/1`；个人空间的路由未验证 |
| 应用入口 | `?launchApp=SYNO.Foto.AppInstance` | 直接 goto 该 URL 可保持登录态 |
| 条目卡片 | `[data-testid="file-clickable-area"]` | 卡片 id 在 `file-draggable-zone-(\d+)` 里 |
| 坏图 | class `synofoto-item-image-broken`（位于 `div[data-testid="item-image-status"]`） | 照片/视频共用，与条目类型无关 |
| 视频条目 | class `synofoto-item-image-video` | 同样能进「生成预览」队列 |
| 未加载缩略图 | `img[data-testid="item-image"]` 没有 `src` 属性 | **提交后同一秒就消失，不能当完成信号** |
| 已加载缩略图（**唯一可信的完成信号**） | `[data-testid="file-clickable-area"]:has([data-testid="item-image"].synofoto-item-image-loaded)` | `loaded >= all` 才算转换完成 |
| 子目录卡片 | `[data-testid="folder-click-area"]`；快照里按 `folder-draggable-zone-(\d+)` 切分 | `H.st.folders` 用快照切分；换版本时先与 locator 计数交叉验证 |
| 选中态（**每卡片 2 节点**） | `[data-testid="basic-selectable_0"].checked` + `.synofoto-selectable-wrapper.checked` | 用它计数会翻倍 |
| 选中态（每卡片 1 节点，推荐） | `[data-testid="file-clickable-area"]:has(.synofoto-selectable-wrapper.checked)` | 区间选择是否成功就靠它 |
| 单张选择按钮 | `button[data-testid="select-button"]` | 区间选择的锚点；**它是开关**：卡片已 checked 时再点一次会**取消**选中（`H.selTap` 内部先判 checked，返回 true 后计数读到 0 也按 1 处理） |
| 目录封面坏图（**另一类缺陷**） | 卡片是 `synofoto-small-item-folder-item`，不是 `file-clickable-area` | 目录内 `all=1` 且没有照片；扩展的「生成预览」对它**不生效**，在 `res2[id].err` 标 `folder-cover-broken` 单列（实测 3488/3515/3642/4052），既不算失败也不算完成 |
| 缩略图尺寸 | `button[aria-label="更改预览大小"]` → `[aria-label="small thumbnail size"]` | 容量**随视口变化**（见陷阱 16）；`更改预览大小` 按钮可能不存在（页面上只剩 small/medium/large thumbnail size），`H.sizeSmall` 吞错，调完必须复测窗口容量 |
| 右键菜单 | `.synofoto-right-click-menu` + 其中 `button` 名为「生成预览」 | 菜单 `boundingBox.x = -50000` 表示被 parked，等于没打开 |
| 配额弹窗 | 点「生成预览」后出现名为「确定」的按钮 | 文案：您每个空间最多可以新增120个项目以生成预览 |
| 目录条目总数 | 页面文本 `(\d+)\s*个项目` | `H.totalShown()`；**空目录没有这行文本** |
| 空目录 | 文本「无项目」+ `[data-testid="empty-view-wrapper"]` | 实测 2249：`countText=[]`、`total=null`、`emptyView=true`。`empty-view` 与 `.empty-view-wrapper` 两个选择器都命中 0，别用 |

子目录卡片判据：`H.st().folders` 数快照里的 `folder-draggable-zone-` 出现次数，locator 侧对应 `[data-testid="folder-click-area"]`。**`processTree` 的子目录清单一律走 `H.listChildren` API 分页枚举，快照只做交叉校验**——快照只有渲染窗口那一段，拿它当清单会整支漏跑（2026-11-11 的 7227 事故）。换 DSM 版本时先跑 `H.probe()` 打印 `testids`，并在一个含子目录的页面上交叉验证两者计数。

某次 `H.probe()` 在只含媒体条目的页面上采样到的 testid 全集（可作对照基线）：
`arrow-button, avatar-menu-btn, basic-selectable_0, breadcrumbs, file-clickable-area, file-content, folder-wall-footer, icon-button-icon, icon-text-button-icon, item-image, item-image-container, item-image-status, item-top-indicator, list-bottom-loading-indicator, list-root, list-root-wrapper, main-grid, menu, profile-btn, row-wrapper, select-button, synofoto-filetree-divider-wrapper, synofoto-filetree-expand-button, synofoto-filetree-wrapper, synofoto-react-select, thumbnail-size-changing-btn, toolbar-change-to-timeline-btn, toolbar-filter-off-btn, toolbar-more-btn, toolbar-new-btn, toolbar-photo-request-btn, toolbar-slideshow-btn, toolbar-sorting-btn, upload`。
注意这份采样里**没有**文件夹卡片专属 testid——它来自只放媒体条目的目录；要固化子目录选择器，必须在含子目录的目录页（如根容器 `folder/1`）再跑一次 `H.probe()`。另外 `thumbnail-size-changing-btn` 可能是「更改预览大小」按钮的真实 testid，可作为 `aria-label` 失效时的备选定位。

## 交互机制（已验证）

- 区间选择：点第 a 张的 `select-button`，再 `click({modifiers:['Shift']})` 第 b 张 → 精确选中 a..b。实测锚第 0 张 + Shift 第 95 张 = 96 张（DOM 里 192 个 checked 节点）。
- 单张选择：`focus()` + `press('Space')`。`hover()` 与 `page.mouse` 在 browser-use SDK 的 locator 上不可用。
- 清空选择：`Escape`（一键清空，不要逐张反选）。
- 网格是虚拟化的：翻页用 `body` 的 `Home` / `PageDown`；窗口身份用 `firstId~lastId`，两次快照同 key 说明到头了。

## 实测性能与阈值

| 项目 | 数值 | 影响 |
| --- | --- | --- |
| 空间级待处理预览配额 | 120 条/共享空间 | 超限整批拒绝，不是部分成功 |
| 单批上限（工程取值） | 110 | 留余量避开配额 |
| 逐张点选耗时 | 平均 6.7 秒/张（110 张≈12 分钟） | 区间选择是唯一可行路径 |
| 扩展桥单次往返 | 2–8 秒 | 每目录地板耗时约 25–40 秒 |
| `PW().waitForTimeout(ms)` | **单次往返约 4.6 秒**（与传入的 ms 无关） | 一律换成 `H.sleep(ms)`（本地 `setTimeout`，零往返）；引擎已全量替换，写新代码别再用它 |
| 页面内 `evaluate` 快原语 | 一次往返做完「点选 + 轮询 checked」 | `H.selTap` / `H.selShift`（elementFromPoint 合成 Shift）/ `H.selCount2` / `H.menuInfo` / `H.clickGen` / `H.brokenCount` / `H.dialogOpen` / `H.dismissDialog`；失败一律退回 Playwright 慢路径。整轮提速约 2 倍。**弹窗三条（`dialogOpen`/`dismissDialog`/`dialogGate`）只认可见对话框并按文案分类，见陷阱 20** |
| 转换速率（扩展端侧） | **约 0.5 张/秒**（硬下限） | 排空预算按这个估：二轮干净目录 ~4s、有坏图目录 30–65s，脏区一格只推进 10–13 个目录 |
| 单窗口条目（**随视口变化，不是常数**） | 最大化实测 198；Chrome 重启后视口变小，同一轮 13 目录抽样为 81 / 100 / 143 | 决定翻页次数与「大目录」阈值；窗口缩小后 >120 项目录的尾部扫不到（陷阱 16） |
| 大目录收敛实测 | 目录 22（261 项）提交 259 项 / 6 批 / 1 次配额退避 / 340 秒 | 提交优先、复检靠第二遍更省时间 |

## 已知陷阱（都曾造成错误结论）

1. **`broken` 与 `nosrc` 都不可作为完成判据**：实测目录 4112（16 张坏图），提交前 `{all:16, loaded:0, bad:16, nosrc:16}`，点完「生成预览」**同一秒**变成 `{all:16, loaded:2, bad:0, nosrc:0}`，约十几秒后才 `loaded:16`。（更早一轮曾观察到「提交后短期仍是坏图、完成后 81→0 阶跃恢复」，两次现象不一致，可能与取样时机/是否重新导航有关；结论是 bad 的变化规律不稳定，别依赖它。）**只有 `loaded >= all` 才是完成**。旧版 drain 用 `bad===0` 判完成，导致提交后立刻切目录、转换被打断（用户两次报「没等预览生成就退回上一级」）。
2. **排空预算被提交阶段吃光**：pumpX2 会吃满给它的预算（只在末尾留 20s）。若按 `pump = deadline-now-90000` 分配，排空阶段算出的预算恰好 ≈20000，被 `drainBudget > 20000` 挡掉，**整段排空被静默跳过**。必须用 `H.splitBudget()` 先扣 120s 排空预留再决定能不能提交；不够就暂停，不要「提交了再说」。
3. **`sent>0` 却因 `blocked` 跳过排空**：sel-fail / budget / quota 时前面几批已经提交出去了，`!r.blocked` 这种条件会把这些图直接丢下。只要提交过就必须排空。
4. **别用「已提交 id 集合」跨轮去重**：否则「提交过但没转出来」的条目永远不会被重提，大目录会长期全坏却报「已完成」。跨轮只看 `broken` 实际状态；本轮内可以按已提交 id 去重（`runDone`），避免刚提交的条目被重复提交。
5. **`checked` 节点数 = 卡片数 × 2**：误判超量会退回逐张点选，慢到跑不完。
6. **排空等待被截断**（残留的 `drainCap`）会导致「以为没转 → 再提一批」，白白挤占配额。
7. **上一批残留选中**会让本批实选数超出预期，直接触发配额拒绝；每批前先 `Escape`。
8. **右键要点卡片本体**，点到文件名文本上菜单是 parked 状态，等于没提交。
9. **配额满时逐目录重试无效**：待处理量是空间级的，撞配额后必须做空间级排空（`H.spaceDrain`）而不是继续提交或放弃目录。
10. **cell 在 turn 结束时被杀**：长时间跑批要按 chunk 切分，chunk 的 `deadlineMs` 留出余量小于 cell `timeout_ms`，并每批 `persist()` 落盘，这样中断后能读台账恢复而不必重放写操作。
11. **goto 后页面可能十几秒才渲染出瓦片**：实测 goto + 9s 等待后 `all=0/folders=0` 而 `totalShown=2`，再等几秒才出现 2 个瓦片。所以 `all===0` 必须先过渲染宽限（默认 20s）再结合 `total`/`folders` 判 `empty` 还是 `not-rendered`，不能直接当空目录。`H.waitRender()` 就是这道理：`all>0 || folders>0` 立刻放行；`total===0 || emptyView` 判 empty；宽限用完仍空则返回 `not-rendered` 并暂停（`NOT_RENDERED`），**绝不当空目录标 done**。
12. **空目录没有「N 个项目」文本**：`H.totalFrom()` 返回 null。只靠 `total===0` 判空会把真·空目录判成没渲染，进而每格都在同一目录暂停（死循环）。必须同时认「无项目」+ `data-testid="empty-view-wrapper"`（见上表）。
13. **会话过期会伪装成导航失败**：Photos 深链落到 `?launchApp=SYNO.Foto.Sharing.AppInstance&app_name=...&photos_action=external_login&folderId=<id>#/signin`，门户 `https://<host>/` 落在 `#/signin`（DOM 有 `input[name=password]`、`aria-label="登录"`）。实测 2026-11-10 11:11，距上一格 02:31Z（本地 10:31）约 40 分钟空闲，超过 DSM 默认 30 分钟自动登出。这不是渲染问题，重试无效，也不能标 done：停下来让人重新登录（建议勾「保持登录」或把控制面板→安全性→自动登出调长）。
14. **kernel 回收后 boot 会开新标签**：`browser.user.openTabs()` 只列「未被认领的用户标签」，claim 过/本库新建过的 Photos 页不会出现；`__tab` 丢了就直接 `tabs.new()`，每格多一个孤儿标签，而扩展只在活动页转换。现在 `H.boot()` 会先看 `browser.tabs.selected()`，URL 同时命中 host 和 `launchApp=SYNO.Foto.AppInstance`（或 `#/<space>/folder/`）才复用，否则才新建。注意 DSM 门户页也是同一 host，不能只看 host。
15. **`H.ready().ok` 不认 adopted**：它的判定是 `claimed || created`。直接复用活动标签时 `ok=false`，此时看 `boot.adopted` 与 `H.probe()` 是否正常，别误判为启动失败。
16. **渲染窗口随视口变化，滚动不一定推得动**：早先最大化窗口实测 198 张（`2238 {all:198, bad:0, loaded:198, total:242}`、`2696 {198/0/198/271}`）。Chrome 重启后视口变小，2026-11-11 的 13 目录抽样里窗口容量是 **81 / 100 / 143** 三种：

    | 目录 | total | `st.all` | `audit.swept` | 说明 |
    | --- | --- | --- | --- | --- |
    | 7439 | 171 | 81 | 143 | 滚动**推进过**（swept > all） |
    | 2238 | 242 | 143 | 143 | 滚动一步没动（swept == all） |
    | 2696 | 271 | 143 | 143 | 同上 |
    | 2702 | 273 | 100 | 100 | 同上 |

    所以 **`PageDown` 不是「一律无效」**，按目录实测；`swept == all` 就是「没推进」的信号。缩窗状态下逐项试过的手段：

    | 手段 | 实测结果 |
    | --- | --- |
    | `H.sizeSmall()` | `更改预览大小` 按钮不存在（只剩 small/medium/large thumbnail size），两次 click 都被 `.catch(()=>{})` 吞掉，窗口容量不变 |
    | 程序化改 `list-root-wrapper.scrollTop` | scrollHeight 1508 / clientHeight 783，scrollTop 最多到 725 就到底，**不再加载更多**；写进去的值被回弹 |
    | `scrollIntoViewIfNeeded(末张卡片)` | 只推进一页，之后不动 |
    | `pw.mouse.wheel(...)` | 这个 shim 里 `pw.mouse` 是 undefined |
    | body `PageDown`（`H.pageDown`） | 2238/2696/2702 上无效：窗口 key `firstId~lastId` 不变 → `H.audit` 判「到头了」提前 break；7439 上有效 |
    | 派发 wheel 事件 | 同样推不动 |
    | `SYNO.Foto.Browse.Item` API 直取 | 个人空间接口：返回 HTML。**共享空间要用 `SYNO.FotoTeam.Browse.Item`，返回 JSON（2026-11-11 实测）** |

    结论：目录视图**只虚拟挂载窗口内的卡片**，滚动容器不是加载更多的入口。**不要再靠调窗口/滚动来拿全目录结论**：直接用页面上下文里的 `SYNO.FotoTeam.Browse.Item`（`method=list&version=7&folder_id=<id>&additional=["thumbnail"]&sort_by="takentime"&sort_direction="asc"&offset=N&limit=100`，头 `x-syno-token`）分页列出全部条目，再逐条 `HEAD /synofoto/api/v2/t/Thumbnail/get?id=..&cache_key=%22..%22&type=%22unit%22&size=%22sm%22&SynoToken=..`：404=缺、200=有；`size="xl"` 同法。**元数据 `additional.thumbnail.sm` 不可信**（2696/2702 有 40/130 条写 ready 而 HEAD 404）。并发 8 约 100 次/秒。
    修复窗口外的坏图：把「排序方式」切成**降序**，尾巴进入窗口（2696 的 40 条一次全进）；一次 evaluate 点掉所有 broken 卡片的 `select-button` → 工具条「生成预览」→ `H.drain` 等 `loaded>=all`；装不下的 `H.pageDown()` 再选（2702 三批 81+36+13）。修完用 HEAD 逐项复验。右键菜单/灯箱的「生成预览」在扩展没被识别的窗口会弹 `external_convert_intro`（「请先安装扩展」），**工具条按钮才可靠**。
    连带后果：`H.p2Pass` 的 capped 分支是 `ok = deep.broken === 0`，**不查 `swept >= 页项数`**，所以缩窗跑大目录会把只核验了 81–143 项的目录标成干净。跑完必须逐个核对 `L.aud[id].swept` 与 `folders[id].total`。
    计数口径：`H.parse(H.snap())` 切的是快照文本里的 `file-clickable-area` 标记，`H.grid().count()` / `querySelectorAll` 数的是活 DOM，**两者不同源、不保证一致**；判据统一用快照口径，不要互相「校正」。
17. **Chrome 整个重启后的半初始化页面会伪装成空目录**：URL 已经落到 `#/shared_space/folder/<id>`，但 `H.st()` 全 0 且 `emptyView:true`。而 `H.waitRender`（L298）与 `H.stSettled`（L125）的判据是 `st.total === 0 || st.emptyView`，**不核对台账 total**，于是有项目的目录被判 empty，`p2Pass` 紧接着写 cleanMark。恢复顺序（2026-11-11 实测跑通）：
    ① `chrome_devtools.list_pages` 确认标签没了 → `navigate_page { type:'url', url:'https://<host>/?launchApp=SYNO.Foto.AppInstance', timeout:45000 }`。**第一次读到 `#/signin/password` 先重读一次**：实测它经 `external_login` 自己回到 `#/shared_space/folder/1`（侧栏共享文件夹都在）= 会话还活着；只有重读仍停在登录表单（`#account`/`#password` 字段在）才是真过期，停机等人工。读 URL 用 `list_pages` 或 `chrome_devtools.evaluate_script`（这条通道有返回值；browser-use shim 的 `page.evaluate` 恒 null）。
    ② 会话活着也可能全 0：这时 `H.goto(id)` 反复调用没用，要 `navigate_page { type:'url', url:'https://<host>/?launchApp=SYNO.Foto.AppInstance#/shared_space/folder/<id>', timeout:60000 }` 做**整页导航**（真文档导航，不是只改 hash）。
    ③ 这一步会自动多开一个 `https://<host>/` 门户标签：`list_pages` 拿它的 `pageId` → `close_page { pageId }`，只留一个 Photos 标签，否则 boot 认领歧义。
    ④ `H.probe()` 确认渲染出卡片再跑批量。
    连接层报错（「没有可用的外部浏览器」）只进 `rep.errs`，不标 done、不提交，收尾仍 persist，游标零损失（实测 8 个目录 7435/7436/7437/7438/7440/7441/7442/7443）。
18. **前台判据是 `visibilityState`，不是「标签被选中」；被完全遮挡也算 hidden**（2026-11-11 实测，代价最大的一条）：
    - 10:20 用户切去别的网站 → `document.visibilityState='hidden'` → 之后 4 个目录全 `stalled`（`loaded 0/7`、`0/19`、`0/12`），**每目录白烧 115–180s 还挤占空间级配额**。扩展只在可见页面转换，后台提交等于白提。
    - 11:21 更隐蔽：Photos 是**选中页**、`hasFocus=true`，`visibilityState` 仍 `hidden` ⇒ Chrome 的原生窗口遮挡计算 `CalculateNativeWinOcclusion` 把被别的窗口完全盖住的窗口判成隐藏。
    - **SDK 侧无解，别再逐个试**（都实测过）：

      | 手段 | 实测结果 |
      | --- | --- |
      | `visibility.set(true)`（SDK 能力） | 只恢复**最小化**，对遮挡无效 |
      | `Page.bringToFront`（CDP） | 被 CDP allowlist 拒绝 |
      | `management` 能力 | 只开放 `getVersion` / `getWindows` / `getSessionName`，没有置前/改窗口状态 |
      | 注册表策略 `HKCU\…\Google\Chrome\CalculateNativeWinOcclusion=0` | **不生效**（重启后仍 hidden） |

    - **有效解（15:3x 实测）**：让人用命令行重启 Chrome 带 `--disable-features=CalculateNativeWinOcclusion --restore-last-session <launchApp URL>`。复测（窗口 `state=maximized`、`focused=false`，即被完全遮挡）：`visibilityState=visible, hasFocus=false`。**最小化 / 切到别的标签页仍会 hidden，所以闸要留着**：`H.visibility()` 读判据、`H.foregroundGate({waitMs})` 每 10s 探一次，等不到就 `{ok:false, reason:'tab-hidden'}` → 收尾回报，绝不提交。
    - 重启的连带坑：DSM `launchApp` 会多开一个 `https://<host>/` **门户标签**，两个同 host 标签让 `boot()` 报 ambiguous → claim + `close_page` 关掉门户标签；此后 boot 走 **adopted** 分支，`ready().ok=false` 但实际可用（见陷阱 15）。
19. **CDP 会话整格卡死是人工停机点**：实测一个目录完成后，接下来 3 个目录连续报 `Tool command waited too long in queue`，随后 `tab.url()` / `tabs.selected()` / `tabs.new()` 全部超时，**新建浏览器会话也无效**。只能让人刷新或关掉重开那个 Photos 标签页（有弹窗先点掉），再 `H.ready()` 从游标继续；报错目录未标 done 会自动重跑。别原地重试，也别误判成登录过期。
20. **弹窗识别：全表扫「确定」按钮＝可能点下删除确认**（2026-11-12 事故，用户报「为什么刚才弹出删除界面」）：
    - 现场：gap 补跑期间页面出现「**在删除之前启用回收站** —— File Station 中的回收站可让您恢复从 Synology Photo 删除的项目…」。这是 DSM 拦下的一次删除尝试（回收站没开，删除没执行）。**取证（只读）**：用 Folder/Item 接口把整棵树重数一遍分 4 块对比审计基线 —— `shrunk=[] grew=0 errs=0`，**没有任何目录或条目丢失**；但弹窗文案里「从 Synology Photo 删除的项目」是 DSM 的通用措辞，不足以证明删的就是这个库点出来的，触发路径也无法事后取证（`L.tr` 内存日志随 kernel 回收丢了 —— 又一条例外要记：判据日志别只挂内存）。
    - 库里确实存在的两条可疑路径：① 旧 `dialogOpen`/`dismissDialog` 遍历 `document.querySelectorAll('button')` 找**第一个**「确定」并直接 `click()` —— 删除确认框的按钮正是它；② `genPreview2` 的右键失败分支 `continue` **不关残留右键菜单**，菜单第一项是「删除」，而 `selSpan3`/翻页点击带 `force:true`（跳过可操作性检查，也不做遮挡命中测试），下一次点选可能直接打在菜单项上。
    - 判据修正：**关掉但没卸载的对话框节点仍留在 DOM**，按 `button` 文本全表扫会一路误报「有弹窗」（实测连按 Escape 也"关不掉"，因为那些本来就不是开着的）；必须按节点判可见 —— `getBoundingClientRect().width > 10` + `getComputedStyle` 的 `display/visibility/opacity`，并连带检查 `ReactModal__Overlay` / `mask` 祖先（隐藏遮罩里的内容不算开着）。候选选择器集中在 `H.DIALOG_SEL`。
    - 分类集中在纯函数 `H.classifyDialog(文案)`：`danger`（删除/移除/回收站/清空/永久/格式化/注销/退出登录/卸载 + 英文同名次）优先于 `quota`（同时命中「生成预览」与「最多可以新增/每个空间最多/待处理预览任务/超过」），认不出＝`other`，空＝`none`。**危险词优先**是刻意的：一条文案同时提到两者时宁可当危险处理。
    - 行为收敛（= 弹窗护栏）：`dialogOpen()` 只对 `quota` 为真；`dismissDialog()` 只点**那个配额对话框内部**的确定（页内源码先按文案定位节点，再在节点作用域里找按钮），`danger`/`other` 连页面都不进（一次 evaluate 都不发）；`dialogGate()` 在 `pumpX2` 每批点选前拦 `danger`/`other` ⇒ `blocked:'dialog-blocking'`、`done:false`，零提交经 `submitAndDrain` 变成 `SUBMIT_BLOCKED` 暂停，绝不标完成；`genPreview2` 每次换候选前与三次候选都用尽后都 `H.dismissMenu()`（Escape 关菜单，吞错）；工具条点过但没生效且页上挂着认不出的弹窗时**不再走右键慢路**（`reason:'dialog-blocking'`）。
    - 代价：每批多一次 evaluate 往返（2–8s），只在「这一批确实有坏图要点」时才花；干净目录不付这个钱。
    - 现场遇到 `danger`：一个按钮都不要点，把文案原样回报给人，由他决定（runbooks「删除/未知弹窗挡住时」）。别自行点「确定」或「取消」—— 那两类按钮的语义正是「确认删除」。

## 台账落盘与自愈（已按 TDD 修，`test_persist_atomic.mjs`）

- **原子替换**：`persist()` 先写 `<台账>.tmp` 再 `renameSync` 覆盖主文件，跑完不留 `.tmp`。起因是实测事故：直接 `writeFileSync` 覆写 900KB 台账时，常驻监视进程读到半截文件，报 `SyntaxError: Expected double-quoted property name in JSON at position 930625`。写的人自己没事，但**内核若恰好在同一时刻被回收**，重启 `load()` 会抛异常 → 二轮游标从零开始。
- **`.bak` 自愈**：`load()` 不再裸 `JSON.parse`。主文件坏/缺而 `.bak` 可读时，**用 `.bak` 修好主文件并恢复游标**；两个都坏才返回 `{loaded:false, reason:'corrupt'}`，并把内存（含 `p2.done`）一起清零 —— **绝不抛异常、也绝不带着半个游标继续跑**。
- **`corrupt` 的处置是手工救，不是重跑整轮**：按修改时间挑最新的 `ledger-*.bak` / `ledger-*.conflict-*`，逐个验能 `JSON.parse`、`folders/vDone/p2.done/totSent` 数量对得上，`cp` 成主文件后再 `H.load()`。直接重跑会白烧几小时浏览器时间。
- **`force:true` 不写 `.bak`**（走的是另一条分支）：撤销假标记前自己 `copyFileSync` 留一份 `.before-revoke`。
- **附加证据一起落盘**：固定白名单之外的自有字段（`apiAudit` / `repair` / `headAudit` / `apiAuditMeta` …）都写盘并在 `load` 时读回；`__` 前缀内部状态与 `tr` 内存日志不落盘；换台账时附加字段一并清零（防串任务）。审计结论仍要另写一份独立 JSON。

## 台账 schema（`__LED` / 持久化 JSON）

```
folders[id]        = {id, name, total, kids}    // 目录清单；name 是完整路径，total 是页面「N 个项目」= 直属条目 + 子目录卡片，kids 是 API 枚举到的子目录数
                                               // ⇒ 图片槽位 = total - kids。旧版不记 kids（2026 台账 1257 条里只有 45 条有），
                                               //   缺 kids 时别把 total 当图片数：纯容器（total==kids）会被误判成「全是图且无证据」
                                               // processTree 重入时整条覆盖（不是合并），事后写的 src:'api-recheck-…' 会被冲掉
                                               // 手工建档（API 补漏）必须写 name，不是 path：p2Pass 取 f.name || id 当 node.path，
                                               //   写成 path 会让报告/排空日志里的路径退化成裸 id（2026 台账 32341–32345 这 5 条就是）
res2[id]           = {id, pass, total, sent, batches, quota, drained, stillBadWindow, blocked, clean, done, elapsed, windowsSeen, win}
                                               // win = 这次判干净覆盖了多少张（pumpX2 的 rec 写）；H.debtPaid 靠它决定能不能销 needDrain 欠账
                                               // err:'folder-cover-broken' = 目录封面坏图，扩展修不了，单列（见选择器表）
res2[id].drain     = {reason, loaded, all, bad, waited, at}   // 排空审计：reason=converted 才是真的转换完；all 只覆盖渲染窗口
res2[id].repair    = {smBrokenBefore, items, batches, fixed, drain, at, via}   // 尾部/窗外补修记账（desc-sort + toolbar）
res2[id].noTiles   = true                       // 只有子目录、没有图片瓦片
subm[id][itemId]   = 1                          // 本目录提交过的条目 id（跨轮只作记录，不作重提门槛）
stuckIds[itemId]   = {folder, video, why}       // 只应记录「确实无法选中」的条目
vQueue             = [id...]                    // 待处理队列；quota/budget/stuck-window/gp-* 会重新入尾，最多 3 次
pendingSamples     = [id...]                    // 空间级排空探针目录（刚提交过、之前是好的）
treeStack          = [{id, path, phase}]        // DFS 栈，末元素是下一个要处理的节点；phase ∈ enter|exit
vDone[id]          = {id, total, done}          // 已处理目录；由 processTree（enter/exit）或 pumpX2 写，p2Pass 判干净的分支不写
needDrain[id]      = {total, at, sent, why}     // 已提交但还没排空完；续跑进该目录时先补排空，converted/empty 后删除；why:'revoke' 是撤销假标记时补的欠账
                                               // 销账判据 H.debtPaid(r,total)：r.clean 且（win>=total 整页覆盖 / noTiles / total===0）才删；
                                               // 证据只盖渲染窗口时保留欠账（7979：82 项、窗口 81、converted，窗外那条 HEAD sm 404）
retry[id]          = n                          // stalled/timeout 等记账，第二遍复检补做；>=6 时 p2.done 标 2
aud[id]            = {id, swept, broken, noSrc, videos, at}   // H.audit 滚动全扫；swept < 页项数时 broken===0 只是窗口内结论
headAudit[id]      = {id, total, n, pages, nock, types, videos, smBad, xlBad, other, errs, ok, at}
                                               // scripts/head_audit.mjs 的单目录逐项 HEAD 证据（附加字段，persist 会落盘）
                                               // ok = n>0 && nock===0 && smBad/xlBad/other/errs 四个都空；other 是非 200/404，算结论不确定
p2.done[id]        = 1 | 2 | 3                  // 二轮游标：1=亲验干净，2=六次仍坏（已知坏，不是假干净），3=证据/审计采信
totSent            = n                          // 该台账累计提交条目数
```

`stillBadWindow` 是提交后快照里的坏图数，**不是完成度指标**：实测 98% 的已提交目录该值为 0（2025 年 756/760、2026 年 376/380），因为 broken class 在提交瞬间就消失了。要看转换结果请读 `res2[id].drain`。

报告口径要分开：会话内 `totSent` 与跨会话累计不能混为一谈；「已提交但仍是坏图」单列；`stuckIds` 若被旧版引擎污染（把待处理条目也记进去），必须在报告里说明并只采用带 `why:'unselectable'` 的条目。
