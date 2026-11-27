// ==UserScript==
// @name         B站客户端双栏布局（评论区移到右侧，边看边刷评）
// @namespace    https://github.com/WanZiDream/bilibili-client-layout
// @version      1.4.8
// @description  把B站视频页改成客户端式单屏双栏，可拖拽调宽、边看边评；鼠标停在画面上滚轮可调音量（全屏/网页全屏时播放器的一切都交还B站自带）。
// @author       0WanZi
// @license      MIT
// @match        *://www.bilibili.com/video/*
// @match        *://www.bilibili.com/list/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @homepageURL https://github.com/WanZiDream/bilibili-client-layout
// @supportURL  https://github.com/WanZiDream/bilibili-client-layout/issues
// @downloadURL https://raw.githubusercontent.com/WanZiDream/bilibili-client-layout/main/bilibili-client-layout.user.js
// @updateURL   https://raw.githubusercontent.com/WanZiDream/bilibili-client-layout/main/bilibili-client-layout.user.js
// ==/UserScript==

(function() {
    'use strict';

    const DEBUG = false; // 正式保持关闭；开启后仅输出 [BCTR] 日志。
    function log()   { if (DEBUG) console.log.apply(console, ['[BCTR]'].concat([].slice.call(arguments))); }

    // 新标准要求组件定义时自带 connectedMoveCallback；B站未实现，只在定义前补空回调。
    // B站先绑定窗口滚动、后渲染 .trigger；等首次渲染后再让它建立原生续页观察器。
    function installCommentCompatibility() {
        const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const registry = pageWindow.customElements;
        if (!registry) return;
        const originalDefine = registry.define;
        if (originalDefine.bctrCommentCompatibility) return;
        const define = function (name, constructor, options) {
            if (name === 'bili-comments') {
                const proto = constructor.prototype;
                if (typeof pageWindow.Element.prototype.moveBefore === 'function' && !proto.connectedMoveCallback) {
                    Object.defineProperty(proto, 'connectedMoveCallback', {
                        configurable: true,
                        value: function () {}
                    });
                }
                const addLoadEvent = proto.addLoadEvent;
                if (typeof addLoadEvent === 'function' && !addLoadEvent.bctrWaitForTrigger) {
                    const pendingLoads = new WeakSet();
                    const compatibleAddLoadEvent = function () {
                        if (this.continueTrigger || !this.showContinueTrigger || !this.updateComplete || pendingLoads.has(this)) {
                            return addLoadEvent.apply(this, arguments);
                        }
                        const args = arguments;
                        pendingLoads.add(this);
                        Promise.resolve(this.updateComplete).then(() => {
                            pendingLoads.delete(this);
                            if (this.isConnected) addLoadEvent.apply(this, args);
                        });
                    };
                    compatibleAddLoadEvent.bctrWaitForTrigger = true;
                    proto.addLoadEvent = compatibleAddLoadEvent;
                }
                const getList = proto.getList;
                if (typeof getList === 'function' && !getList.bctrRetryEmptyHotPage) {
                    // 热门接口偶尔连续返回空页但游标仍前进；最多补跑五次，避免用户来回滚动。
                    const compatibleGetList = function () {
                        this.__bctrEmptyHotRetryToken = null;
                        if (this.mode !== 3) this.__bctrEmptyHotRetries = 0;
                        const beforeLength = this.list?.length || 0;
                        const beforePagination = this.paginationStr;
                        return Promise.resolve(getList.apply(this, arguments)).then(() => {
                            if (this.mode !== 3 || this.showEnd || this.showSpinner || this.showContinuations) return;
                            const listLength = this.list?.length || 0;
                            if (listLength > beforeLength) {
                                this.__bctrEmptyHotRetries = 0;
                                return;
                            }
                            if (this.paginationStr === beforePagination) return;
                            const retries = this.__bctrEmptyHotRetries || 0;
                            if (retries >= 5) {
                                this.__bctrEmptyHotRetries = 0;
                                return;
                            }
                            this.__bctrEmptyHotRetries = retries + 1;
                            // 补跑间隔保持原生“正在加载”，避免请求间隙闪烁。
                            const retryToken = {};
                            this.__bctrEmptyHotRetryToken = retryToken;
                            this.showContinuations = true;
                            return new Promise((resolve) => setTimeout(resolve, 120)).then(() => {
                                if (this.__bctrEmptyHotRetryToken !== retryToken) return;
                                this.__bctrEmptyHotRetryToken = null;
                                this.showContinuations = false;
                                if (this.isConnected && this.mode === 3 && !this.showEnd && !this.showSpinner && !this.showContinuations) {
                                    return compatibleGetList.call(this);
                                }
                            });
                        });
                    };
                    compatibleGetList.bctrRetryEmptyHotPage = true;
                    proto.getList = compatibleGetList;
                }
            }
            return originalDefine.call(this, name, constructor, options);
        };
        define.bctrCommentCompatibility = true;
        registry.define = define;
    }
    installCommentCompatibility();

    // 页面间是 SPA 跳转，路由须实时读取。
    function isListPage() {
        return window.location.pathname.startsWith('/list/');
    }

    const CONFIG = {
        vdconSelector: "#mirror-vdcon",
        leftContainerSelector: "#mirror-vdcon .left-container",
        playlistLeftContainerSelector: "#mirror-vdcon .playlist-container--left",
        rightContainerSelector: "#mirror-vdcon .right-container",
        playlistRightContainerSelector: "#mirror-vdcon .playlist-container--right",
        rightInnerClass: "right-container-inner",
        commentAppSelector: "#commentapp",
        // hydration 前抢走 SSR 节点会导致评论永久空白；超时后只搬简介，绝不碰评论容器。
        shellReadyTimeoutMs: 10000,
        shellGiveUpTimeoutMs: 30000,
        // 换壳期间保留双栏外观，避免闪回原布局。
        routeLayoutGraceMs: 3000,
        // 按钮须独立挂在工具条右侧组；塞进 inline-flex 的「笔记」会挤坏其布局。
        toolbarRightSelector: "#arc_toolbar_report > .video-toolbar-right",
        playlistToolbarRightSelector: "#playlistToolbar > .video-toolbar-right",
        // /list/ 没有右侧组，退回工具条本体。
        toolbarSelector: "#arc_toolbar_report",
        playlistToolbarSelector: "#playlistToolbar",
        // 节点会搬入面板，且祖先带系统后缀，不能写死祖先链。
        playlistTitleLinkSelector: ".video-info-title h1 a",
        // /video/ 与 /list/ 的信息节点都要搬入简介，否则会被左栏样式隐藏。
        introMovesFromLeft: [
            ".video-info-container",    // 标题/播放量/发布时间（/video/ 页它就是 #viewbox_report，同一个节点）
            "#arc_toolbar_report",      // 点赞/投币/收藏/分享 工具条（/video/）
            "#playlistToolbar",         // 同上（/list/：工具条换了 id）
            ".video-desc-container",    // 简介正文（/video/ 页它就是 #v_desc，同一个节点）
            "#bgm-entry", // 延迟挂载的音乐入口也须随简介搬入。
            ".video-tag-container",     // 标签
            ".video-resource-list"      // 附件/资源
        ],
        // 搬进「简介」选项卡的节点（原右栏信息块）。
        // 顺序 = 面板里从上到下的顺序，且外壳必须排在它的内层之前（见 syncPanelContents）
        introMovesFromRight: [
            ".up-panel-container",      // UP主头像/充电/关注
            ".video-pod-above-modules", // 弹幕列表等（/video/；#danmukuBox 在它内部，跟着一起搬）
            "#danmukuBox",              // 弹幕列表（/list/：没有 above-modules 外壳，得单独搬）
            ".video-pod",               // 合集/播放列表（/video/）
            ".action-list-container",   // 稍后再看/收藏夹的播放列表（/list/）
            ".recommend-list-container",// 推荐视频（/list/）
            ".recommend-list-v1"        // 推荐视频（/video/）
        ],
        // 面板与控件ID
        panelId: "bctr-panel",
        tabbarId: "bctr-tabbar",
        tabIntroId: "bctr-tab-intro",
        tabCommentId: "bctr-tab-comment",
        dragHandleId: "bctr-drag-handle",
        sbTrackId: "bctr-sb-track",
        sbThumbId: "bctr-sb-thumb",
        styleSettings: {
            // 右栏面板宽度占 #mirror-vdcon 内容宽度的百分比
            defaultRightPercent: 25,
            minRightPercent: 16,
            maxRightPercent: 50,
            // 面板滚动条样式：
            //   overlay     = 只留一根自绘浮动滑块，无轨道无占位（默认）
            //   transparent = 系统细滚动条 + 透明轨道（仍占约10px宽）
            //   hidden      = 完全隐藏
            //   native      = 浏览器默认
            scrollbarMode: 'overlay'
        },
        // 播放器画面内滚轮调音量；全屏时交给播放器原生行为。
        wheelVolume: {
            steps: [2, 5, 10, 20],   // 菜单里可循环切换的步长（百分比）
            defaultStep: 5,
            minStep: 1,
            maxStep: 20,
            notchPx: 100,            // 一格滚轮折算多少 deltaY；触控板的小 delta 先累积，够一格才动作
            osdId: "bctr-volume-osd",
            osdHideDelay: 900        // 中央提示条停留多久（毫秒）
        },
        // 滚轮调音量的生效范围：指针落在这些节点内部才接管，
        // 面板/推荐列表等其它位置的滚轮照常滚动
        playerWheelScope: "#playerWrap, .bpx-player-container, .bpx-player-video-area, #bilibili-player",
        healer: {
            // 缓存不存在的节点，避免体检反复查询；被替换的缓存节点靠 isConnected 失效。
            nodeMissTtlMs: 3000,
            guardRetryTicks: 5,
            guardFastRetries: 3 // 已认领节点丢失时先快速自愈，再退避。
        }
    };

    // 左右栏选择器在宽度样式与布局样式里各出现多次（视频页/列表页两种形态），拼一次复用
    const LEFT_SEL = `${CONFIG.leftContainerSelector}, ${CONFIG.playlistLeftContainerSelector}`;
    const RIGHT_SEL = `${CONFIG.rightContainerSelector}, ${CONFIG.playlistRightContainerSelector}`;

    let layoutEnabled = GM_getValue('clientLayout', true) !== false; // 客户端双栏布局开关
    let rememberTab = GM_getValue('rememberTab', false) === true;   // 记住上次页签（默认关，保持"默认评论"）
    let activeTab = (rememberTab && GM_getValue('activeTab', '') === 'intro') ? 'intro' : 'comment';
    let rightPercent = Number(GM_getValue('rightWidthPercent', CONFIG.styleSettings.defaultRightPercent));
    let layoutStyleEl = null;   // 客户端布局总样式（关闭时清空）
    let staticStyleEl = null;   // 常驻样式（拖拽手柄 + 切换按钮），只建一次
    let dragHandle = null;
    let toggleBtn = null;
    let isDragging = false;
    let lastResizeNotify = 0;
    let lastAppliedPercent = null; // 宽度去重：百分比没变就不再写
    let lastWidthHost = null;      // 宽度写在哪个元素上（换容器要重写）
    let appliedTab = '';           // 已经落到 DOM 上的页签，避免每 5 秒重复写 hidden/class
    let resetCommentScrollOnReady = false;
    let lastNudgedCommentApp = null;
    let lastNudgedCommentRoute = '';
    let geoDirty = true;           // 几何脏标记：尺寸变化后才重新量手柄位置/滚动条
    // SPA 路由指纹：path/search 分开存，直接比较两个字段，省掉每秒一次的字符串拼接
    let lastRoutePath = '', lastRouteSearch = '';
    let routeShellPending = false;
    let routeOldVdcon = null;
    let routeOldLeft = null;
    let routeOldRight = null;
    let routeOldCommentApp = null;
    let routeReusedCommentApp = null;
    let routeShellDeadline = 0;
    let layoutGraceUntil = 0;
    let tickCount = 0;
    // 拖拽期间预取的几何量：拖拽中每帧只做算术，不读布局
    let dragContentW = 0, dragContentRight = 0;
    // 页面补全（hydration）进度：B站客户端脚本还没把 SSR 骨架补全之前，一个节点都不能搬
    let shellDeadline = 0;      // 兜底截止时间戳（0 = 未开始计时）
    let shellHardDeadline = 0;  // 终极截止：到点后只搬简介，不碰 #commentapp
    let movesPending = false; // 是否正处在"等补全、暂不搬节点"的状态
    // 补全完成前【不能往B站的容器里插任何节点】（面板已改挂 body），⇄ 按钮/拖拽手柄也要等
    let shellInjectionOk = false;
    // 滚轮调音量：开关/步长/提示条都能在脚本菜单里改
    let wheelVolumeEnabled = GM_getValue('wheelVolume', true) !== false;
    let wheelVolumeOsd = GM_getValue('wheelVolumeOsd', true) !== false;
    let wheelVolumeStep = normalizeWheelStep(GM_getValue('wheelVolumeStep', CONFIG.wheelVolume.defaultStep));
    let wheelAccum = 0;      // 触控板/惯性滚动累积的 deltaY：不够一格先攒着，方向反转立刻清零
    let wheelOsdEl = null;   // 中央音量提示条（懒建；被B站吞掉会自动重建）
    let wheelOsdV = -1;      // 提示条里已写入的音量，值没变就不重写文本
    let wheelOsdTimer = 0;
    // 常用节点缓存：体检每秒都会用到，缓存后常态零查询（B站换掉节点时 isConnected=false 会自动重查）
    const nodeCache = {
        playerContainer: null, miniBtn: null, commentComp: null,
        videoEls: null, videoEl: null, toggleMount: null, toggleMountType: '', toggleMountInBar: false
    };
    // 记录被搬移节点的原父节点/原后继，供切回原布局时精确归位
    const movedOrigin = new Map();
    // 已搬移节点登记表：体检时只看 isConnected / parentElement，不做全文档查询
    const trackedMoves = [];
    // 防丢失自愈缓存
    const guardCache = new Map();
    // 需要自愈的关键节点及其应处父容器（B站重渲染偶尔会吞掉它们）；每秒体检都会遍历，故提到模块级
    const GUARD_RULES = [
        { sel: ".video-info-title", parent: ".video-info-container" },
        { sel: ".up-panel-container", parent: "#" + CONFIG.tabIntroId },
        { sel: ".video-pod-above-modules", parent: "#" + CONFIG.tabIntroId }
    ];
    // 布局容器缓存：这几个节点在页面生命周期内不会变，反复 querySelector 纯属浪费
    const elCache = { vdcon: null, left: null, right: null, panel: null, tabIntro: null, tabComment: null };

    function cachedQuery(key, selector) {
        const el = elCache[key];
        if (el && el.isConnected) return el;
        return (elCache[key] = selector ? document.querySelector(selector) : null);
    }

    function cachedById(key, id) {
        const el = elCache[key];
        if (el && el.isConnected) return el;
        return (elCache[key] = document.getElementById(id));
    }

    // 查询失败也短暂缓存；被替换的节点仍靠 isConnected 失效。
    const nodeMissAt = {
        playerContainer: 0, miniBtn: 0, videoEl: 0, videoEls: 0,
        commentComp: 0, toggleMount: 0, titleLink: 0
    };
    const EMPTY_NODES = [];   // 负缓存命中时返回的共享空列表（省掉每次新建数组）

    function missCooling(key) {
        const at = nodeMissAt[key];
        return at !== 0 && (Date.now() - at) < CONFIG.healer.nodeMissTtlMs;
    }

    // "查一次就记住"：命中负缓存直接返回 null，否则查一次并记下成功/失败。
    // selector 可以是选择器字符串，也可以是个小函数（多选择器兜底时用）。
    function lookupOnce(key, selector) {
        if (missCooling(key)) return null;
        const found = typeof selector === 'function'
            ? selector() : document.querySelector(selector);
        return rememberLookup(key, found);
    }

    function rememberLookup(key, found) {
        nodeMissAt[key] = found ? 0 : Date.now();
        return found;
    }

    function resetNodeMiss() {
        for (const key in nodeMissAt) nodeMissAt[key] = 0;
    }

    /* ================= 基础工具 ================= */

    function safeDOMOperation(operation) {
        try {
            return operation();
        } catch (error) {
            console.error('[BCTR] DOM操作失败:', error);
            return null;
        }
    }

    function clampPercent(p) {
        p = Number(p);
        if (!isFinite(p)) return CONFIG.styleSettings.defaultRightPercent;
        p = Math.min(CONFIG.styleSettings.maxRightPercent,
                     Math.max(CONFIG.styleSettings.minRightPercent, p));
        // 0.1% 精度肉眼无差，但能让拖拽时大量 mousemove 落在同一个值上，从而跳过样式重写
        return Math.round(p * 10) / 10;
    }

    // 把高频回调（scroll / resize / mousemove）合并成"每帧最多执行一次"。
    // 过去滚动条、拖拽、resize 各写了一份 pending 标志位，逻辑重复，这里统一成一个工厂。
    function coalesceRaf(fn) {
        let pending = false;
        return function () {
            if (pending) return;
            pending = true;
            requestAnimationFrame(() => { pending = false; fn(); });
        };
    }

    function getVdcon() { return cachedQuery('vdcon', CONFIG.vdconSelector); }

    function getLeftContainer() {
        return cachedQuery('left', isListPage() ? CONFIG.playlistLeftContainerSelector : CONFIG.leftContainerSelector);
    }

    function getRightContainer() {
        return cachedQuery('right', isListPage() ? CONFIG.playlistRightContainerSelector : CONFIG.rightContainerSelector);
    }

    function getPanel()      { return cachedById('panel',      CONFIG.panelId); }
    function getTabIntro()   { return cachedById('tabIntro',   CONFIG.tabIntroId); }
    function getTabComment() { return cachedById('tabComment', CONFIG.tabCommentId); }

    // 只有完整左右栏和播放器锚点同时存在时才接管页面；模板变化时保留B站原布局，避免锁死滚动。
    function layoutCanApply() {
        if (routeShellPending && getVdcon() === routeOldVdcon) return false;
        const left = getLeftContainer();
        return !!(getVdcon() && left && getRightContainer() && left.querySelector('#playerWrap'));
    }

    function layoutVisualsCanApply() {
        return layoutEnabled && (layoutCanApply() || Date.now() < layoutGraceUntil);
    }

    /* ---- 体检热路径上的节点缓存 ----
       1 秒一次的体检过去会做十几次全文档查询（播放器容器、迷你窗、<video>、bili-comments…），
       这里统一缓存；节点被B站换掉时 isConnected 变 false，会自动重查一次。 */
    function getPlayerContainer() {
        const el = nodeCache.playerContainer;
        if (el && el.isConnected) return el;
        return (nodeCache.playerContainer = lookupOnce('playerContainer', () =>
            document.querySelector('#playerWrap .bpx-player-container') ||
            document.querySelector('.bpx-player-container')));
    }

    function getMiniPlayerBtn() {
        const el = nodeCache.miniBtn;
        if (el && el.isConnected) return el;
        return (nodeCache.miniBtn = lookupOnce('miniBtn', '.mini-player-window'));
    }

    function getVideoEls() {
        const els = nodeCache.videoEls;
        if (els && els.length && els[0].isConnected) return els;
        if (missCooling('videoEls')) return EMPTY_NODES;
        const found = document.querySelectorAll('video');
        rememberLookup('videoEls', found.length > 0);
        return (nodeCache.videoEls = found);
    }

    // 播放器里那个 <video>（滚轮调音量用）。只认播放器内部，
    // 免得误伤页面里可能存在的其它视频（广告/预览等）
    function getWheelVideoEl() {
        const v = nodeCache.videoEl;
        if (v && v.isConnected) return v;
        return (nodeCache.videoEl = lookupOnce('videoEl', () =>
            document.querySelector('#playerWrap video') ||
            document.querySelector('.bpx-player-container video')));
    }

    function getCommentComp() {
        const el = nodeCache.commentComp;
        if (el && el.isConnected) return el;
        return (nodeCache.commentComp = lookupOnce('commentComp', 'bili-comments'));
    }

    // 缓存全清：SPA 换视频 / 切回原布局后调用，避免拿着上一页面的节点当缓存
    function dropNodeCache() {
        nodeCache.playerContainer = null;
        nodeCache.miniBtn = null;
        nodeCache.commentComp = null;
        nodeCache.videoEls = null;
        nodeCache.videoEl = null;
        nodeCache.toggleMount = null;
        nodeCache.toggleMountType = '';
        nodeCache.toggleMountInBar = false;
        resetNodeMiss();     // 负缓存一起作废：新页面可能立刻就有这些节点
    }

    // 面板滚动条样式：overlay / transparent / hidden / native（旧版本的 hideScrollbar 开关自动迁移）
    // GM_getValue 是跨沙箱同步调用，而这个函数在滚动热路径上每秒被调几十次，必须缓存。
    // 用 null 作为"未初始化"哨兵：normalizeScrollbarMode 保证不会返回 null/undefined。
    const SCROLLBAR_MODES = ['overlay', 'transparent', 'hidden', 'native'];
    const SCROLLBAR_LABELS = {
        overlay:     '仅一根浮动滑块（无轨道、不占位）',
        transparent: '系统细滚动条 + 透明轨道',
        hidden:      '完全隐藏',
        native:      '浏览器默认'
    };
    let scrollbarModeCache = null;

    function normalizeScrollbarMode(m) {
        return SCROLLBAR_MODES.indexOf(m) !== -1 ? m : CONFIG.styleSettings.scrollbarMode;
    }

    function getScrollbarMode() {
        if (scrollbarModeCache === null) {
            scrollbarModeCache = normalizeScrollbarMode(GM_getValue('scrollbarMode', ''));
        }
        return scrollbarModeCache;
    }

    function setScrollbarMode(m) {
        scrollbarModeCache = normalizeScrollbarMode(m);
        GM_setValue('scrollbarMode', scrollbarModeCache);
        return scrollbarModeCache;
    }

    /* ================= 样式 ================= */

    // 三个 <style> 元素共用这一个入口：不存在（或被B站重渲染删掉）时才新建
    function styleSlot(current, id) {
        if (current && current.isConnected) return current;
        const el = document.createElement('style');
        el.id = id;
        (document.head || document.documentElement).appendChild(el);
        return el;
    }

    // 左右栏宽度：右栏 P%，左栏占满剩余。
    // 宽度写成右栏的行内 !important（不重写 <style> 文本，也不用 CSS 变量）：
    //   · 重写 <style> 文本 = 每帧重新解析 CSS + 全页样式失效；
    //   · 自定义属性写在 vdcon 上 = 变量可继承，每帧把整棵子树（含播放器）拉进样式重算
    //     （实测拖拽 60 帧：重算+布局 470ms，写行内只有 180ms）；
    //   · 行内只影响这一个元素，实测拖拽 60 帧重算+布局从 380ms 降到 180ms。
    function clearInlineWidth(el) {
        if (!el) return;
        for (const prop of ['flex', 'width', 'max-width', 'min-width']) el.style.removeProperty(prop);
    }

    function applyWidths() {
        const right = getRightContainer();
        if (!right) return;
        const p = layoutVisualsCanApply() ? clampPercent(rightPercent) : null;
        // 面板是 #app 之外的悬浮层，宽度必须由 JS 给（否则 auto 会撑成一整屏）；
        // 这条很轻，放在下面的去重检查之前，保证任何路径进来都能同步到
        const panel = getPanel();
        if (panel) {
            const w = p === null ? '' : (p + 'vw');
            if (panel.style.width !== w) panel.style.width = w;
        }
        // 常态（值没变、宿主没换、行内声明还在）直接返回，拖拽之外基本零成本
        if (p !== null && p === lastAppliedPercent && right === lastWidthHost
            && right.style.getPropertyPriority('flex') === 'important') return;
        if (lastWidthHost && lastWidthHost !== right) clearInlineWidth(lastWidthHost);
        lastAppliedPercent = p;
        lastWidthHost = p === null ? null : right;
        if (p === null) { clearInlineWidth(right); return; }
        if (right.style.getPropertyPriority('max-width') !== 'important') {
            right.style.setProperty('max-width', 'none', 'important');
            right.style.setProperty('min-width', '0', 'important');
        }
        right.style.setProperty('flex', '0 0 ' + p + '%', 'important');
        right.style.setProperty('width', p + '%', 'important');
    }

    // 手柄位置 / 滚动条几何都靠这个标记按需重算，取代"每秒读一次布局"
    function markGeometryDirty() { geoDirty = true; }

    // ResizeObserver 事件驱动更新几何；换容器时重新观察，避免持有旧节点。
    let layoutRO = null;
    let observedVdcon = null, observedRight = null, observedLeft = null, observedPlayer = null;

    function syncLayoutObservers() {
        if (!window.ResizeObserver) return;
        if (!layoutRO) {
            layoutRO = new ResizeObserver(coalesceRaf(() => {
                geoDirty = true;
                if (layoutEnabled && !isDragging) positionHandle();
                if (getScrollbarMode() === 'overlay') updateOverlayScrollbar();
                if (layoutEnabled && layoutCanApply()) updatePlayerLayout(false);
            }));
        }
        const vdcon = getVdcon();
        if (vdcon !== observedVdcon) {
            if (observedVdcon) { try { layoutRO.unobserve(observedVdcon); } catch (e) {} }
            observedVdcon = vdcon;
            if (vdcon) { try { layoutRO.observe(vdcon); } catch (e) {} }
        }
        const right = getRightContainer();
        if (right !== observedRight) {
            if (observedRight) { try { layoutRO.unobserve(observedRight); } catch (e) {} }
            observedRight = right;
            if (right) { try { layoutRO.observe(right); } catch (e) {} }
        }
        const left = getLeftContainer();
        if (left !== observedLeft) {
            if (observedLeft) { try { layoutRO.unobserve(observedLeft); } catch (e) {} }
            observedLeft = left;
            if (left) { try { layoutRO.observe(left); } catch (e) {} }
        }
        const player = left && left.querySelector('#playerWrap');
        if (player !== observedPlayer) {
            if (observedPlayer) { try { layoutRO.unobserve(observedPlayer); } catch (e) {} }
            observedPlayer = player;
            if (player) { try { layoutRO.observe(player); } catch (e) {} }
        }
    }

    // 常驻样式：拖拽手柄 + ⇄ 切换按钮。
    // 这两个控件在「B站原布局」下也要能用（尤其切换按钮），所以不能塞进会被清空的布局样式；
    // 过去每个控件各自 append 一个 <style>，控件被重建一次就多一个样式节点，现在统一只建一次。
    function ensureStaticStyle() {
        staticStyleEl = styleSlot(staticStyleEl, 'bctr-static-style');
        if (staticStyleEl.dataset.filled) return;
        staticStyleEl.dataset.filled = '1';
        staticStyleEl.textContent = `
            #${CONFIG.dragHandleId} {
                position: absolute;
                top: 0;
                bottom: 0;
                /* 手柄就挂在（body 层的）面板左边缘上，跟着面板走，不用再算位置 */
                left: 0;
                width: 16px;
                margin-left: -8px;
                cursor: col-resize;
                z-index: 5;
                background: transparent;
                /* 触屏/触控笔：拖拽交给 pointer 事件，禁止浏览器把它当成页面滚动/缩放 */
                touch-action: none;
            }
            #${CONFIG.dragHandleId} .bctr-handle-line {
                position: absolute;
                top: 0;
                bottom: 0;
                left: 50%;
                width: 3px;
                margin-left: -1.5px;
                border-radius: 2px;
                background: transparent;
                transition: background 0.15s;
            }
            #${CONFIG.dragHandleId}:hover .bctr-handle-line,
            #${CONFIG.dragHandleId}.dragging .bctr-handle-line {
                background: #fb7299;
            }
            #${CONFIG.dragHandleId} .bctr-handle-bubble {
                position: absolute;
                top: 45%;
                left: 50%;
                transform: translateX(-50%);
                padding: 2px 8px;
                border-radius: 6px;
                background: rgba(33, 33, 33, 0.85);
                color: #fff;
                font-size: 12px;
                line-height: 18px;
                white-space: nowrap;
                display: none;
                pointer-events: none;
            }
            #${CONFIG.dragHandleId}.dragging .bctr-handle-bubble {
                display: block;
            }
            /* 双击复位 / 菜单复位这类一次性变宽：给个短过渡，拖拽时由 JS 摘掉这个类 */
            html.bctr-anim ${RIGHT_SEL} {
                transition: flex-basis 0.18s ease, width 0.18s ease;
            }
            html.bctr-anim #${CONFIG.panelId} {
                transition: width 0.18s ease;
            }
            @media (prefers-reduced-motion: reduce) {
                html.bctr-anim ${RIGHT_SEL},
                html.bctr-anim #${CONFIG.panelId} { transition: none; }
            }
            .comment-toggle-btn {
                border-radius: 6px !important;
                display: inline-flex;
                flex: 0 0 auto;
                align-items: center;
                justify-content: center;
                width: 28px;
                height: 28px;
                margin-left: 8px;
                background-color: #fb7299;
                color: white;
                border: none;
                cursor: pointer;
                vertical-align: middle;
                font-size: 14px;
                transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
                position: relative;
                overflow: hidden;
                box-sizing: border-box;
                z-index: 1;
            }
            /* 挂到工具条本体（/list/ 页没有右侧组）时自己贴到最右 */
            .comment-toggle-btn.bctr-toggle-in-bar {
                margin-left: auto;
            }
            @media (prefers-color-scheme: dark) {
                .comment-toggle-btn {
                    background-color: #ff85ad;
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
                }
            }
            /* 拖拽中：整个窗口都是拖拽光标、不能选中文字，播放器也不再抢指针事件 */
            html.bctr-dragging,
            html.bctr-dragging * {
                cursor: col-resize !important;
                user-select: none !important;
            }
            html.bctr-dragging #playerWrap,
            html.bctr-dragging #playerWrap * {
                pointer-events: none !important;
            }
            /* 键盘可达性：页签与切换按钮的 focus 轮廓（鼠标点击不显示） */
            #${CONFIG.tabbarId} .bctr-tab:focus-visible,
            .comment-toggle-btn:focus-visible {
                outline: 2px solid #fb7299;
                outline-offset: -2px;
            }
            /* 滚轮调音量的中央提示条：只在「客户端双栏布局 + 播放器非全屏」时出现
               （全屏 / 网页全屏下脚本不接管滚轮，音量指示由B站自带的负责）。
               改的是 <video> 原生音量，B站不一定给反馈，这里自己弹一个。
               fixed + translate 居中，left/top 由 showVolumeOsd 按播放器盒子算。
               z-index 取到接近上限：B站播放器/弹幕层的层级很高（上万），
               普通数值会被压在画面下面 */
            #${CONFIG.wheelVolume.osdId} {
                position: fixed;
                z-index: 2147483600;
                transform: translate(-50%, -50%) scale(0.96);
                padding: 8px 16px;
                border-radius: 10px;
                background: rgba(20, 20, 22, 0.78);
                color: #fff;
                font-size: 15px;
                line-height: 22px;
                /* 数字等宽：连续调音量时数字不会左右抖 */
                font-variant-numeric: tabular-nums;
                white-space: nowrap;
                pointer-events: none;
                opacity: 0;
                transition: opacity 0.15s ease, transform 0.15s ease;
            }
            /* 全屏 / 网页全屏下的音量指示由B站自带，脚本在那里不接管滚轮，
               所以没有"全屏宿主"那套 absolute + 50% 居中的样式了 */
            #${CONFIG.wheelVolume.osdId}.show {
                opacity: 1;
                transform: translate(-50%, -50%) scale(1);
            }
            @media (prefers-reduced-motion: reduce) {
                #${CONFIG.wheelVolume.osdId} { transition: none; }
            }
        `;
    }

    // 客户端式双栏总样式（layoutEnabled 为 false 时清空，页面回到B站原样）
    function buildLayoutStyle() {
        layoutStyleEl = styleSlot(layoutStyleEl, 'bctr-layout-style');
        if (!layoutVisualsCanApply()) { layoutStyleEl.textContent = ''; return; }

        // 普通与宽屏模式接管媒体区；全屏、网页全屏和小窗交给B站。
        const np = (sel) => {
            const s = sel ? ' ' + sel : '';
            return `#playerWrap .bpx-player-container[data-screen="normal"]${s},
            #playerWrap .bpx-player-container[data-screen="wide"]${s},
            #playerWrap .bpx-player-container:not([data-screen])${s}`;
        };

        // 播放器链路上每一层都要清掉的约束（B站个别层自带内边距/边框/宽高比/transform，
        // 会在画面四周露黑缝或让尺寸不跟随左栏），拼成一个模板给多条规则复用
        const ZERO = `max-width: none !important;
                min-width: 0 !important;
                margin: 0 !important;
                padding: 0 !important;
                border: 0 !important;
                transform: none !important;`;

        const scrollbarMode = getScrollbarMode();
        // 两个页签各自的滚动容器：简介页签仍是 .bctr-tabbody；评论页签的滚动器是里面的
        // #commentapp（见布局里 #commentapp 那段注释：滚动容器让给了B站评论组件）。
        const scrollTargets = [
            `#${CONFIG.panelId} .bctr-tabbody`,
            `#${CONFIG.tabCommentId} > #commentapp`
        ];
        // 标准属性（Chromium 121+/Firefox）与 ::-webkit-scrollbar 二选一：
        // 新内核只要声明了 scrollbar-width / scrollbar-color 就会忽略 -webkit- 伪元素，
        // 所以两套都写上——新内核走标准属性，老内核走 -webkit- 兜底。
        const hideNative = scrollTargets.map((s) => `
            ${s} { scrollbar-width: none !important; }
            ${s}::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
        `).join('');
        const innerTransparent = scrollTargets.map((s) => `
            /* 面板内部自己的小滚动区（如合集 .video-pod__body）也去掉轨道底色 */
            ${s} * {
                scrollbar-width: thin !important;
                scrollbar-color: rgba(140, 140, 140, 0.45) transparent !important;
            }
        `).join('');
        let scrollbarCss = '';
        if (scrollbarMode === 'overlay') {
            // 原生滚动条完全隐藏（不占位），改由自绘浮动滑块指示位置
            scrollbarCss = hideNative + innerTransparent;
        } else if (scrollbarMode === 'hidden') {
            scrollbarCss = hideNative;
        } else if (scrollbarMode === 'transparent') {
            /* 透明底：只留一根半透明细滑块，轨道/角落全透明，深浅色主题都不突兀 */
            scrollbarCss = scrollTargets.map((s) => `
                ${s} {
                    scrollbar-width: thin !important;
                    scrollbar-color: rgba(140, 140, 140, 0.45) transparent !important;
                }
                ${s}::-webkit-scrollbar {
                    width: 8px;
                    height: 8px;
                    background: transparent;
                }
                ${s}::-webkit-scrollbar-track,
                ${s}::-webkit-scrollbar-track-piece,
                ${s}::-webkit-scrollbar-corner {
                    background: transparent;
                    border: none;
                }
                ${s}::-webkit-scrollbar-thumb {
                    background-color: rgba(140, 140, 140, 0.45);
                    border-radius: 4px;
                    background-clip: padding-box;
                }
                ${s}::-webkit-scrollbar-thumb:hover {
                    background-color: rgba(251, 114, 153, 0.75);
                }
            `).join('') + innerTransparent;
        }
        const hiddenLeftInfo = CONFIG.introMovesFromLeft.map((sel) =>
            `${CONFIG.leftContainerSelector} > ${sel},\n            ${CONFIG.playlistLeftContainerSelector} > ${sel}`
        ).join(',\n            ');

        layoutStyleEl.textContent = `
            /* 单屏化：整页不滚动，像客户端一样一屏放下；
               外层容器（body/#app/.bili-video-page）的内外边距也清零，
               否则左栏外侧会露出一条页面底色缝 */
            html, body {
                overflow: hidden !important;
                height: 100% !important;
                margin: 0 !important;
                padding: 0 !important;
            }
            #app, .bili-video-page {
                margin: 0 !important;
                padding: 0 !important;
                border: 0 !important;
            }
            /* 客户端式沉浸：隐藏B站顶栏（logo/导航/搜索），播放器从屏幕最顶端开始 */
            #biliMainHeader, .bili-header, #internationalHeader {
                display: none !important;
            }
            /* 单屏布局下播放器永远在视口内，B站的"迷你播放器"浮窗入口没有意义，直接隐藏 */
            .mini-player-window, .mini-player-window-icon {
                display: none !important;
            }
            /* 把 vdcon 直接钉死到视口：外层容器（body/#app/页面壳）任何水平内边距或居中
               都会让左栏外侧露出一条页面底色缝（实测 6px）。position:fixed 一步脱离所有
               祖先约束；单屏布局下页面本来就不滚动，fixed 没有副作用 */
            ${CONFIG.vdconSelector} {
                position: fixed !important;
                left: 0 !important;
                top: 0 !important;
                height: 100vh !important;
                max-height: 100vh !important;
                overflow: hidden !important;
                margin: 0 !important;
                padding: 0 !important;
                border: 0 !important;
                width: 100vw !important;
                max-width: none !important;
            }
            /* 左右栏宽度：百分比由 applyWidths 以行内 !important 写在右栏上（拖拽每帧只改 2 个属性，
               既不重写样式表、也不用自定义属性把整棵子树拉进样式重算），这里只留兜底默认值和静态约束 */
            ${RIGHT_SEL} {
                flex: 0 0 ${CONFIG.styleSettings.defaultRightPercent}% !important;
                width: ${CONFIG.styleSettings.defaultRightPercent}% !important;
                max-width: none !important;
                min-width: 0 !important;
            }
            ${LEFT_SEL} {
                flex: 1 1 0 !important;
                width: auto !important;
                min-width: 0 !important;
                max-width: none !important;
            }
            /* 左栏：只留播放器，铺满视口高度；内/外边距清零，避免栏本身留出黑缝 */
            ${LEFT_SEL} {
                height: 100vh !important;
                max-height: 100vh !important;
                overflow: hidden !important;
                position: relative !important;
                margin: 0 !important;
                padding: 0 !important;
                border: 0 !important;
            }
            /* 已知信息块仅移出视野并保留宽度；display:none 会触发B站宽度测量越界和整页重渲染。 */
            ${hiddenLeftInfo} {
                position: absolute !important;
                left: -20000px !important;
                top: 0 !important;
                width: 100% !important;
                height: auto !important;
                visibility: hidden !important;
                pointer-events: none !important;
            }
            #playerWrap {
                height: 100vh !important;
                max-height: 100vh !important;
                width: 100% !important;
                margin: 0 !important;
                padding: 0 !important;
            }
            /* 清零播放器链路的内边距/边框以免露黑缝；全屏和小窗不碰祖先层，保留B站排版。 */
            html:not(.${FS_CLASS}) #playerWrap #bilibili-player {
                width: 100% !important;
                height: 100% !important;
                ${ZERO}
            }
            html:not(.${FS_CLASS}) #playerWrap .bpx-docker {
                height: 100% !important;
                ${ZERO}
            }
            ${np('')} {
                height: 100% !important;
                width: 100% !important;
                ${ZERO}
            }
            /* 媒体链改用 block/100%，控制条悬浮贴底，避免播放器 JS 休眠后画面不随左栏缩放。 */
            ${np('.bpx-player-primary-area')} {
                display: block !important;
                width: 100% !important;
                height: 100% !important;
                ${ZERO}
            }
            /* video-area / video-perch / video-wrap 三层约束完全相同，合成一条规则 */
            ${np('.bpx-player-video-area')},
            ${np('.bpx-player-video-perch')}, ${np('.bpx-player-video-wrap')} {
                flex: none !important;
                width: 100% !important;
                height: 100% !important;
                aspect-ratio: auto !important;
                ${ZERO}
            }
            /* 控制层由B站 absolute 贴底，无需脚本摆位。 */
            /* 弹幕发送条原本在媒体区下方占一行（全屏模式本来就没有它），单屏布局里隐藏 */
            ${np('.bpx-player-sending-bar')} {
                display: none !important;
            }
            /* 覆盖B站可能过期的内联视频尺寸，统一 contain 留边。 */
            #playerWrap .bpx-player-video-area video {
                width: 100% !important;
                height: 100% !important;
                object-fit: contain !important;
            }
            /* 右栏：面板容器，原内层内容隐藏（节点已搬进选项卡）
               注意：B站给 right-container / right-container-inner 设了 pointer-events:none，
               必须显式恢复 auto，否则面板点击穿透、滚轮也无法滚动评论 */
            ${RIGHT_SEL} {
                height: 100vh !important;
                max-height: 100vh !important;
                overflow: hidden !important;
                position: relative !important;
                margin-left: 0 !important;
                pointer-events: auto !important;
            }
            ${CONFIG.rightContainerSelector} .${CONFIG.rightInnerClass},
            ${CONFIG.playlistRightContainerSelector} .${CONFIG.rightInnerClass} {
                display: none !important;
            }
            /* 面板本体：悬浮在 #app 之外（见 ensurePanel），盖在右栏位置上 */
            #${CONFIG.panelId} {
                position: fixed !important;
                top: 0;
                right: 0;
                height: 100vh;
                box-sizing: border-box;
                display: flex;
                flex-direction: column;
                min-height: 0;
                z-index: 60;
                background: var(--bg1, #fff);
                pointer-events: auto !important;
            }
            /* 播放器进全屏后就藏起来：网页全屏 / 全屏时B站播放器接管整个视口，
               而本面板是 body 层的 fixed 浮层（z-index: 60）。真机实测网页全屏下
               B站播放器的层级比 60 低，面板会盖在画面上、把右侧约 25% 的画面挡掉
               （2026-10 用户截图复现）。这里连同拖拽手柄、音量提示条一起藏掉。
               ⚠ 用 visibility 而不是 display:none：前者保留布局，内部的评论组件不会被
               量成 0 尺寸（B站对宽度 0 有越界 bug），退出全屏时也不用重算；
               同时显式 pointer-events:none —— 否则这条 25vw 宽的热区仍会抢走
               B站全屏画面右侧的点击。 */
            html.${FS_CLASS} #${CONFIG.panelId},
            html.${FS_CLASS} #${CONFIG.panelId} *,
            html.${FS_CLASS} #${CONFIG.wheelVolume.osdId} {
                visibility: hidden !important;
                pointer-events: none !important;
            }
            #${CONFIG.tabbarId} {
                flex: 0 0 44px;
                display: flex;
                align-items: stretch;
                gap: 4px;
                padding: 0 12px;
                border-bottom: 1px solid var(--line_regular, rgba(128, 128, 128, 0.25));
                box-sizing: border-box;
            }
            #${CONFIG.tabbarId} .bctr-tab {
                display: flex;
                align-items: center;
                padding: 0 10px;
                font-size: 14px;
                color: var(--text1, #18191c);
                cursor: pointer;
                border-bottom: 2px solid transparent;
                user-select: none;
            }
            #${CONFIG.tabbarId} .bctr-tab.active {
                color: #fb7299;
                border-bottom-color: #fb7299;
                font-weight: 600;
            }
            #${CONFIG.panelId} .bctr-tabbody {
                flex: 1 1 auto;
                min-height: 0;
                overflow-y: auto;
                overscroll-behavior: contain;
                padding: 8px 12px 24px;
                box-sizing: border-box;
            }
            /* 未选中的页签：收成 0 高、裁剪、不可见，但【保留布局宽度】而不是 display:none。
               同上，B站的宽度测量必须拿到真实宽度（0 会触发它的越界 bug → 整页重渲染 →
               视频重新加载）。0 高 + overflow:hidden 保证它不占版面、不参与滚动。 */
            #${CONFIG.panelId} .bctr-tabbody[hidden] {
                display: block !important;
                flex: 0 0 0 !important;
                height: 0 !important;
                min-height: 0 !important;
                max-height: 0 !important;
                padding: 0 !important;
                overflow: hidden !important;
                visibility: hidden !important;
                pointer-events: none !important;
            }
            /* 搬进来的信息块在窄栏里的适配（/video/ 与 /list/ 两套 DOM 都列上） */
            #${CONFIG.tabIntroId} .video-info-container,
            #${CONFIG.tabIntroId} #arc_toolbar_report,
            #${CONFIG.tabIntroId} #playlistToolbar,
            #${CONFIG.tabIntroId} .video-desc-container {
                width: 100% !important;
                max-width: none !important;
                margin: 0 !important;
                padding: 4px 0 !important;
            }
            /* /list/ 页的标题块自带 104px 固定高 + 22px 顶部内边距（原是给B站顶栏让位的），
               搬进面板后按内容高度排，否则标题上下各空出一大条。
               /video/ 页同一节点没有高度约束，这条等于没写。 */
            #${CONFIG.tabIntroId} .video-info-container {
                height: auto !important;
                min-height: 0 !important;
            }
            /* 窄栏工具条允许两组换行，按钮不压缩、文字不断行。 */
            #${CONFIG.tabIntroId} .video-toolbar-container {
                flex-wrap: wrap !important;
                row-gap: 8px !important;
            }
            #${CONFIG.tabIntroId} .video-toolbar-left {
                flex: 1 1 auto !important;
                min-width: 0 !important;
            }
            #${CONFIG.tabIntroId} .video-toolbar-left-main {
                flex-wrap: wrap !important;
                row-gap: 6px !important;
                min-width: 0 !important;
            }
            #${CONFIG.tabIntroId} .video-toolbar-left-item {
                width: auto !important;
                min-width: 0 !important;
            }
            #${CONFIG.tabIntroId} .video-toolbar-right {
                flex: 0 0 auto !important;
                max-width: 100% !important;
                flex-wrap: wrap !important;
                row-gap: 6px !important;
            }
            #${CONFIG.tabIntroId} .video-toolbar-right-item {
                flex: 0 0 auto !important;
            }
            #${CONFIG.tabIntroId} .video-toolbar-item-text {
                white-space: nowrap !important;
            }
            #${CONFIG.tabIntroId} .recommend-list-v1,
            #${CONFIG.tabIntroId} .recommend-list-container,
            #${CONFIG.tabIntroId} .video-pod {
                width: 100% !important;
                max-height: none !important;
                overflow: visible !important;
                margin: 8px 0 0 !important;
                padding: 0 !important;
                border: none !important;
            }
            /* /list/ 页的播放列表（稍后再看/收藏夹）：外层去掉B站按右栏算的左右内边距，
               内层 .action-list 保留它自己的滚动条——它靠滚到首/尾的锚点加载上一页/下一页，
               改成 overflow:visible 就再也翻不了页，所以只给它一个高度上限。 */
            #${CONFIG.tabIntroId} .action-list-container {
                width: 100% !important;
                margin: 8px 0 0 !important;
                padding: 0 !important;
            }
            #${CONFIG.tabIntroId} .action-list-container .action-list-body-bottom {
                margin: 0 !important;
            }
            #${CONFIG.tabIntroId} .action-list-container .action-list {
                height: auto !important;
                max-height: 45vh !important;
            }
            /* 评论组件只把可滚动父元素认作 scrollContainer；window 被锁死时必须由 #commentapp 承接翻页监听。 */
            #${CONFIG.tabCommentId} {
                display: flex !important;
                flex-direction: column !important;
                overflow: hidden !important;
                padding: 0 !important;
            }
            #${CONFIG.tabCommentId} > #commentapp {
                flex: 1 1 auto !important;
                width: 100% !important;
                min-height: 0 !important;
                overflow-y: auto !important;
                overscroll-behavior: contain;
                padding: 8px 4px 24px;
                box-sizing: border-box;
            }
            /* 等B站补全期间两个页签都还是空的，给条提示免得以为脚本坏了 */
            .bctr-wait-hint {
                padding: 16px 8px;
                color: var(--text2, #9499a0);
                font-size: 13px;
                line-height: 20px;
            }
            /* 自绘浮动滚动条：没有轨道、不占内容宽度，只有一根滑块，闲置自动淡出 */
            #${CONFIG.sbTrackId} {
                position: absolute;
                right: 0;
                width: 12px;
                z-index: 40;
                pointer-events: none;
                opacity: 0;
                transition: opacity 0.25s ease;
            }
            #${CONFIG.sbTrackId}.show { opacity: 1; }
            #${CONFIG.sbThumbId} {
                position: absolute;
                top: 0;
                right: 3px;
                width: 6px;
                border-radius: 3px;
                background: rgba(140, 140, 140, 0.5);
                pointer-events: auto;
                cursor: default;
                transition: background 0.15s ease;
                will-change: transform;
            }
            #${CONFIG.sbThumbId}:hover,
            #${CONFIG.sbThumbId}.dragging {
                background: rgba(251, 114, 153, 0.85);
            }
            ${scrollbarCss}
        `;
    }

    /* ================= 节点搬移 / 归位 ================= */

    // 已连接节点优先保活移动；未连接节点和旧浏览器仍走 insertBefore。
    function insertNode(node, parent, before = null) {
        if (node.isConnected && parent.isConnected && typeof parent.moveBefore === 'function') parent.moveBefore(node, before);
        else parent.insertBefore(node, before);
    }

    function moveNodeInto(node, target) {
        if (!node || !target || node.parentNode === target) return;
        const rec = movedOrigin.get(node);
        if (!rec || !document.body.contains(rec.parent)) {
            movedOrigin.set(node, { parent: node.parentNode, next: node.nextSibling });
        }
        insertNode(node, target);
    }

    function restoreAllMoved(scope) {
        movedOrigin.forEach((rec, node) => {
            if (!document.body.contains(node)) return;
            if (scope && !((scope.left && (scope.left === rec.parent || scope.left.contains(rec.parent)))
                || (scope.right && (scope.right === rec.parent || scope.right.contains(rec.parent))))) return;
            if (rec.parent && document.body.contains(rec.parent)) {
                const next = rec.next && rec.next.parentNode === rec.parent ? rec.next : null;
                insertNode(node, rec.parent, next);
            }
        });
        movedOrigin.clear();
        trackedMoves.length = 0;
    }

    /* ================= 面板构建 ================= */

    // 简介页签要收纳的节点（左栏信息块 + 原右栏信息块），启动时合并一次即可
    const introSelectors = CONFIG.introMovesFromLeft.concat(CONFIG.introMovesFromRight);

    // 只管面板骨架：建一次，被B站重渲染吞掉就补回来
    function ensurePanel() {
        if (!layoutEnabled) return null;
        return safeDOMOperation(() => {
            if (!layoutCanApply()) return null;

            let panel = getPanel();
            if (!panel) {
                panel = document.createElement('div');
                panel.id = CONFIG.panelId;
                panel.innerHTML = `
                    <div id="${CONFIG.tabbarId}" role="tablist" aria-label="视频信息页签">
                        <div class="bctr-tab" role="tab" tabindex="0" aria-selected="false" data-tab="intro">简介</div>
                        <div class="bctr-tab" role="tab" tabindex="0" aria-selected="false" data-tab="comment">评论</div>
                    </div>
                    <div id="${CONFIG.tabIntroId}" class="bctr-tabbody" role="tabpanel" hidden></div>
                    <div id="${CONFIG.tabCommentId}" class="bctr-tabbody" role="tabpanel" hidden></div>
                    <div id="${CONFIG.sbTrackId}"><div id="${CONFIG.sbThumbId}"></div></div>
                `;
                // ⚠ 面板挂在 <body>（#app 之外）而不是 .right-container：
                // B站 客户端补全时会遍历它自己的 DOM 树，往它的容器里插任何节点都会造成
                // "多出一个它不认识的子节点" → 补全失败 → 整页重渲染 → 播放器被重建、
                // 视频重新加载（实测：只往 .right-container 插一个空 div 就 100% 触发；
                // 插到 body 层则完全不会）。面板样式是 position:fixed，视觉上仍盖在右栏上。
                (document.body || document.documentElement).appendChild(panel);
                // 面板刚创建时清掉缓存，让 getPanel/getTab* 走一次真实查询
                elCache.panel = elCache.tabIntro = elCache.tabComment = null;
                appliedTab = '';                 // 新面板两个页签都是 hidden，页签状态需要重新落一次
                const bar = panel.querySelector('#' + CONFIG.tabbarId);
                bar.addEventListener('click', (e) => {
                    const tab = e.target.closest('.bctr-tab');
                    if (tab) switchTab(tab.getAttribute('data-tab'));
                });
                // Home/End 切页签；左右方向键不拦截，留给B站播放器快进/后退。
                bar.addEventListener('keydown', (e) => {
                    if (e.key !== 'Home' && e.key !== 'End') return;
                    const tabs = Array.from(bar.querySelectorAll('.bctr-tab'));
                    if (!tabs.length) return;
                    e.preventDefault();
                    let i = tabs.indexOf(e.target.closest('.bctr-tab'));
                    if (i < 0) i = activeTab === 'intro' ? 0 : 1;
                    if (e.key === 'Home') i = 0;
                    else i = tabs.length - 1;
                    switchTab(tabs[i].getAttribute('data-tab'));
                    tabs[i].focus();
                });
            }
            initOverlayScrollbar(panel);
            syncLayoutObservers();          // 容器可能换了，重新对齐观察目标
            applyWidths();                  // 面板宽度 = 右栏宽度
            return panel;
        });
    }

    // 仅在首帧、路由变化、体检失败及低频兜底时全量搬移。
    function syncPanelContents() {
        const intro = getTabIntro();
        const commentBody = getTabComment();
        if (!intro || !commentBody) return;

        // ⚠ 两个搬迁时机是分开的（见下方长注释）：
        //   · 简介节点：等B站补全走完
        //   · #commentapp：必须等评论组件真的挂进它里面，否则B站会整页重渲染
        const gate = movesGate();
        if (!gate.intro && !gate.comment) {
            movesPending = true;
            ensureWaitHint();
            switchTab(activeTab, true);
            updateOverlayScrollbar();
            syncCommentShadowStyle();
            return;
        }
        movesPending = !gate.comment;
        shellInjectionOk = true;      // 补全已完成：可以往B站容器里插 ⇄ 按钮 / 拖拽手柄了

        trackedMoves.length = 0;
        const scope = getVdcon();
        if (gate.intro) {
            removeWaitHint(getTabIntro());
            for (const sel of introSelectors) {
                const node = scope ? scope.querySelector(sel) : null;
                if (!node) continue;                     // 这个视频没有该信息块
                // 已经在面板里的节点（含被搬进来的外壳的后代）不再单独搬一次：
                // /video/ 页 #danmukuBox 就在 .video-pod-above-modules 内部，
                // 再搬一次会把它从外壳里撕出来，外壳自己的折叠/吸附逻辑就废了。
                if (intro.contains(node)) continue;
                moveNodeInto(node, intro);
                trackedMoves.push({ node, target: intro });
            }
        }
        if (gate.comment) {
            const commentApp = gate.commentApp;
            if (commentApp) {
                const needsLazyNudge = commentApp.parentNode !== commentBody || resetCommentScrollOnReady;
                moveCommentAppIntoPanel(commentApp, commentBody);
                if (resetCommentScrollOnReady) {
                    if (commentApp !== routeOldCommentApp) commentApp.scrollTop = 0;
                    resetCommentScrollOnReady = false;
                }
                removeWaitHint(commentBody);
                if (needsLazyNudge) triggerCommentLazyLoad();
            }
        }

        switchTab(activeTab, true);
        updateOverlayScrollbar();
        syncCommentShadowStyle();
        createToggleButton();
    }

    /* 等B站 hydration：评论组件是左栏最后一项，提前搬走前面的 SSR 节点会使后续对位错乱，
       B站会放弃加载评论且不重试。因此评论组件挂载前只建面板并显示提示，不搬任何页面节点。 */
    function movesGate() {
        const ca = pickCommentApp();
        // 页面里压根没有评论容器（评论关闭 / 模板不同）：没什么可等的
        if (!ca) return { intro: true, comment: true, commentApp: null };
        // 评论自定义元素已经挂进 #commentapp：B站的对位走完了，随便搬
        if (ca.querySelector('bili-comments')) return { intro: true, comment: true, commentApp: ca };

        const now = Date.now();
        if (!shellDeadline) shellDeadline = now + CONFIG.shellReadyTimeoutMs;
        if (!shellHardDeadline) shellHardDeadline = now + CONFIG.shellGiveUpTimeoutMs;
        // ① 等够 shellReadyTimeoutMs，且完全看不出"评论组件正在赶来"→ 这页不会挂评论组件
        if (now >= shellDeadline && !commentComponentComing()) return { intro: true, comment: true, commentApp: ca };
        // ② 再等到 shellGiveUpTimeoutMs：可以搬简介，但绝不碰 #commentapp
        //    （组件没挂上就搬它 = B站整页重渲染 = 视频重新加载，比"评论空白"更糟）
        if (now >= shellHardDeadline) return { intro: true, comment: false, commentApp: ca };
        return { intro: false, comment: false, commentApp: ca };
    }

    // 有没有"B站正在加载评论组件"的迹象（脚本标签 / 全局构造器 / 自定义元素）
    function commentComponentComing() {
        if (window.BiliComments || window.bbComment) return true;
        if (window.customElements && customElements.get('bili-comments')) return true;
        if (document.querySelector('script[src*="commentpc/"]')) return true;
        return false;
    }

    // 当前壳里的评论容器优先；已经搬进面板的容器只在壳里没有容器时作为兜底。
    // 这样路由过渡期间，面板里的旧评论不会把新壳误判成 hydration 已完成。
    function pickCommentApp() {
        const scope = getVdcon();
        const inShell = scope ? scope.querySelectorAll(CONFIG.commentAppSelector) : [];
        if (inShell.length) return selectCommentApp(inShell);
        const commentBody = getTabComment();
        return commentBody ? selectCommentApp(commentBody.querySelectorAll(CONFIG.commentAppSelector)) : null;
    }

    function selectCommentApp(apps) {
        for (const el of apps) if (el.querySelector('bili-comments')) return el;
        for (const el of apps) if (el.firstElementChild) return el;
        return apps[0] || null;
    }

    function moveCommentAppIntoPanel(commentApp, commentBody) {
        let replaced = false;
        commentBody.querySelectorAll(CONFIG.commentAppSelector).forEach((el) => {
            if (el === commentApp) return;
            el.remove();
            replaced = true;
        });
        if (replaced) clearCommentShadowState();
        moveNodeInto(commentApp, commentBody);
        trackedMoves.push({ node: commentApp, target: commentBody });
        if (commentApp !== routeReusedCommentApp) routeReusedCommentApp = null;
    }

    // 等待期间还没搬内容的页签放一条提示，免得被当成脚本坏了
    function ensureWaitHint() {
        for (const body of [getTabIntro(), getTabComment()]) {
            if (!body || body.querySelector('.bctr-wait-hint')) continue;
            const el = document.createElement('div');
            el.className = 'bctr-wait-hint';
            el.textContent = waitingHintText();
            body.prepend(el);
        }
    }

    function waitingHintText() {
        return (shellHardDeadline && Date.now() >= shellHardDeadline)
            ? 'B站评论组件没就绪（可能被网络或扩展拦住了），刷新页面可重试。'
            : '正在等B站页面脚本就绪…';
    }

    function removeWaitHint(body) {
        const scope = body || getPanel();
        if (!scope) return;
        scope.querySelectorAll('.bctr-wait-hint').forEach((el) => el.remove());
    }

    function resetShellState() {
        shellDeadline = 0;
        shellHardDeadline = 0;
        shellInjectionOk = false;
        movesPending = false;
    }

    // 每秒体检：只读登记表里节点的 isConnected / parentNode，不做任何文档查询
    function panelIsHealthy() {
        if (trackedMoves.length === 0) return false; // 页面还没渲染完，保持全量扫描
        if (movesPending) return false;              // 还在等B站补全，需要每秒重扫一次
        const panel = getPanel();
        const rc = getRightContainer();
        if (!panel || !panel.isConnected || !rc) return false;
        for (const t of trackedMoves) {
            if (!t.node.isConnected || t.node.parentNode !== t.target) return false;
        }
        return true;
    }

    function switchTab(name, silent) {
        safeDOMOperation(() => {
            const intro = getTabIntro();
            const commentBody = getTabComment();
            if (!intro || !commentBody) return;
            const next = (name === 'intro') ? 'intro' : 'comment';
            // 已同步时不重复写 hidden/class。
            const inSync = appliedTab === next
                && intro.hidden === (next !== 'intro')
                && commentBody.hidden === (next !== 'comment');
            if (inSync) return;
            activeTab = next;
            appliedTab = next;
            if (rememberTab) GM_setValue('activeTab', next);
            intro.hidden = next !== 'intro';
            commentBody.hidden = next !== 'comment';
            const bar = document.getElementById(CONFIG.tabbarId);
            if (bar) {
                bar.querySelectorAll('.bctr-tab').forEach(t => {
                    const on = t.getAttribute('data-tab') === next;
                    t.classList.toggle('active', on);
                    t.setAttribute('aria-selected', on ? 'true' : 'false');
                    t.tabIndex = on ? 0 : -1; // 仅当前页签进入 Tab 顺序。
                });
            }
            if (next === 'comment') triggerCommentLazyLoad();
            markGeometryDirty();
            updateOverlayScrollbar();
            if (!silent) log('切换页签:', next);
        });
    }

    function resetPanelForRoute(restoreScope) {
        safeDOMOperation(() => {
            routeReusedCommentApp = null;
            const commentBody = getTabComment();
            const previousCommentApp = commentBody && commentBody.querySelector(CONFIG.commentAppSelector);
            restoreAllMoved(restoreScope);
            resetShellState();
            movesPending = true;
            appliedTab = '';
            const intro = getTabIntro();
            const introHints = intro ? Array.from(intro.querySelectorAll('.bctr-wait-hint')) : [];
            if (intro) intro.replaceChildren(...introHints);
            let preservedCommentApp = false;
            if (commentBody) {
                if (previousCommentApp && previousCommentApp.isConnected
                    && getVdcon() && getVdcon().contains(previousCommentApp)) {
                    moveNodeInto(previousCommentApp, commentBody);
                    routeReusedCommentApp = previousCommentApp;
                    preservedCommentApp = true;
                } else {
                    const commentHints = Array.from(commentBody.querySelectorAll('.bctr-wait-hint'));
                    commentBody.replaceChildren(...commentHints);
                }
            }
            if (preservedCommentApp) syncCommentShadowStyle();
            else clearCommentShadowState();
            ensureWaitHint();
            switchTab(activeTab, true);
            updateOverlayScrollbar();
        });
    }

    function teardownPanel(restoreScope) {
        safeDOMOperation(() => {
            restoreAllMoved(restoreScope);
            resetShellState();
            appliedTab = '';
            const panel = getPanel();
            if (panel) panel.remove();
            if (dragHandle) {
                dragHandle.remove();
                dragHandle = null;
                dragBubble = null;
            }
            clearCommentShadowState();
            elCache.panel = elCache.tabIntro = elCache.tabComment = null;
        });
    }

    // 不能 scrollIntoView：它会滚动 document，触发播放器离屏小窗；只滚动评论容器。
    function triggerCommentLazyLoad() {
        const commentBody = getTabComment();
        if (!commentBody) return;
        const commentApp = commentBody.querySelector(CONFIG.commentAppSelector);
        if (!commentApp) return;                       // 还没搬进面板，什么都不做
        if (activeTab !== 'comment' || commentBody.hidden) return;

        // 自定义元素挂载不等于评论数据已加载，主动触发一次滚动让B站尽快开始懒加载。
        // 同一条路由只唤醒一次，避免定时体检或重复切页签把用户正在看的位置拉回顶部。
        const routeKey = lastRoutePath + lastRouteSearch;
        if (commentApp === lastNudgedCommentApp && routeKey === lastNudgedCommentRoute) return;
        lastNudgedCommentApp = commentApp;
        lastNudgedCommentRoute = routeKey;
        const scroller = getCommentScroller() || commentBody;
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        requestAnimationFrame(() => {
            if (commentApp.isConnected && activeTab === 'comment' && !commentBody.hidden) {
                scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
            }
        });
    }

    /* 评论正文在 Shadow DOM 中；向 open root 注入样式压缩 80px 左内边距，并在重渲染后自愈。 */
    let shadowStyleEl = null;   // 注入评论 shadow 的 <style>：缓存后常态只剩一次属性读
    let observedShadowRoot = null;
    let lastShadowScanAt = 0;
    const shadowObservers = new Map();
    const actionRoots = new Set();
    let openActionMenu = null;

    /* 操作按钮位于多层 shadow，须单独注入：收紧间距、禁止文字竖排，并允许整行换行。
       隔离世界 patch 不到页面原型，但能共享 DOM 并插入样式。 */
    const ACTION_TAG = 'bili-comment-action-buttons-renderer';
    const ACTION_STYLE_ID = 'bctr-action-style';
    const ACTION_CSS = `
        :host { flex-wrap: wrap !important; row-gap: 2px !important; }
        :host > * { white-space: nowrap !important; }
        :host > *:not(:first-child) { margin-left: 12px !important; }
        button { flex: 0 0 auto !important; }
        :host > :last-child { margin-right: 0 !important; }
    `;
    // 按 root 记住塞进去的那份样式：常态每个 root 只剩一次 isConnected 读。
    // 用 WeakMap 而不是 Set，评论翻篇后 root 能被回收（不会拖着一整棵卸载的 DOM）
    const actionStyles = new WeakMap();
    const actionMenus = new WeakMap();

    function injectActionStyle(root) {
        if (!root) return;
        const prev = actionStyles.get(root);
        if (prev && prev.isConnected && prev.parentNode === root) return;
        const st = document.createElement('style');
        st.id = ACTION_STYLE_ID;
        st.textContent = ACTION_CSS;
        root.appendChild(st);
        actionStyles.set(root, st);
    }

    function observeShadowRoot(root) {
        if (!root || shadowObservers.has(root)) return;
        const observer = new MutationObserver((records) => {
            const added = [];
            for (const record of records) {
                for (const node of record.addedNodes) if (node.nodeType === 1) added.push(node);
            }
            if (added.length) {
                resetSbGeom();
                scanShadowNodes(added);
            }
        });
        observer.observe(root, { childList: true, subtree: true });
        shadowObservers.set(root, observer);
    }

    // 只遍历本次新增节点及其后代；遇到 open shadow root 时继续向内观察。
    function scanShadowNodes(nodes) {
        const stack = Array.from(nodes);
        while (stack.length) {
            const el = stack.pop();
            if (!el || el.nodeType !== 1) continue;
            if (el.localName === ACTION_TAG && el.shadowRoot) registerActionRoot(el.shadowRoot);
            if (el.shadowRoot) {
                observeShadowRoot(el.shadowRoot);
                for (const child of el.shadowRoot.children) stack.push(child);
            }
            for (const child of el.children) stack.push(child);
        }
    }

    function registerActionRoot(root) {
        if (!root) return;
        actionRoots.add(root);
        observeShadowRoot(root);
        if (layoutEnabled && activeTab === 'comment') {
            injectActionStyle(root);
            bindActionMenu(root.host, root);
        }
    }

    function syncActionRoots() {
        for (const root of Array.from(actionRoots)) {
            if (!root.host || !root.host.isConnected) {
                forgetActionRoot(root);
                continue;
            }
            injectActionStyle(root);
            bindActionMenu(root.host, root);
        }
    }

    function isInsideActionMenu(node, boundary, menu) {
        let el = node && node.nodeType === 1 ? node : null;
        while (el) {
            if (el === boundary || el === menu) return true;
            const root = el.getRootNode ? el.getRootNode() : null;
            el = root && root.host ? root.host : null;
        }
        return false;
    }

    function closeActionMenu(record) {
        if (!record) return;
        record.host.showMoreMenu = false;
        if (openActionMenu === record) openActionMenu = null;
    }

    function unbindActionMenu(root) {
        const prev = actionMenus.get(root);
        if (!prev) return;
        prev.boundary.removeEventListener('mouseleave', prev.leave);
        prev.trigger.removeEventListener('click', prev.open);
        prev.menu.removeEventListener('select', prev.close);
        closeActionMenu(prev);
        actionMenus.delete(root);
    }

    function forgetActionRoot(root) {
        unbindActionMenu(root);
        const observer = shadowObservers.get(root);
        if (observer) observer.disconnect();
        shadowObservers.delete(root);
        actionRoots.delete(root);
        const style = root.querySelector('#' + ACTION_STYLE_ID);
        if (style) style.remove();
    }

    function bindActionMenu(host, root) {
        if (!root) return;
        const prev = actionMenus.get(root);
        if (prev && prev.host === host && prev.trigger && prev.menu
            && prev.trigger.isConnected && prev.menu.isConnected && prev.boundary.isConnected) return;
        const menu = root.querySelector('bili-comment-menu');
        if (!menu) return;

        // 优先使用原生 ARIA 关系；当前B站模板没有 ARIA 时，再按“按钮与菜单的最近共同容器”发现。
        let trigger = null;
        const menuId = menu.id;
        if (menuId) {
            trigger = Array.from(root.querySelectorAll('[aria-controls]'))
                .find((el) => el.getAttribute('aria-controls') === menuId) || null;
        }
        if (!trigger) {
            const buttons = Array.from(root.querySelectorAll('button, [role="button"]'))
                .filter((el) => !menu.contains(el));
            trigger = buttons.find((el) => el.parentElement && el.parentElement.contains(menu))
                || buttons[buttons.length - 1] || null;
        }
        if (!trigger) return;

        let boundary = menu.parentElement;
        while (boundary && boundary !== root && !boundary.contains(trigger)) boundary = boundary.parentElement;
        if (!boundary || !boundary.contains(trigger)) boundary = root;

        unbindActionMenu(root);

        const record = { host, root, trigger, menu, boundary };
        record.close = () => closeActionMenu(record);
        record.open = () => {
            if (openActionMenu && openActionMenu !== record) closeActionMenu(openActionMenu);
            openActionMenu = record;
        };
        // B站把 mouseleave 绑在零尺寸的菜单宿主上，实际移出弹窗时不会触发。
        record.leave = (event) => {
            if (event.relatedTarget && isInsideActionMenu(event.relatedTarget, boundary, menu)) return;
            record.close();
        };
        boundary.addEventListener('mouseleave', record.leave);
        trigger.addEventListener('click', record.open);
        menu.addEventListener('select', record.close);
        actionMenus.set(root, record);
    }

    function onActionMenuOutside(event) {
        const record = openActionMenu;
        if (!record) return;
        const path = event.composedPath ? event.composedPath() : [event.target];
        if (path.includes(record.boundary) || path.includes(record.menu) || path.includes(record.trigger)) return;
        record.close();
    }

    function onActionMenuKeydown(event) {
        if (event.key === 'Escape' && openActionMenu) openActionMenu.close();
    }

    function installActionMenuGuards() {
        document.addEventListener('pointerdown', onActionMenuOutside, true);
        document.addEventListener('keydown', onActionMenuKeydown, true);
    }

    function clearCommentShadowState() {
        for (const root of Array.from(actionRoots)) forgetActionRoot(root);
        for (const observer of shadowObservers.values()) observer.disconnect();
        shadowObservers.clear();
        actionRoots.clear();
        if (openActionMenu) closeActionMenu(openActionMenu);
        openActionMenu = null;
        if (shadowStyleEl) shadowStyleEl.remove();
        shadowStyleEl = null;
        observedShadowRoot = null;
        lastShadowScanAt = 0;
    }

    function syncCommentShadowStyle() {
        const bc = getCommentComp();          // 缓存：常态下这里不再有全文档查询
        const sr = bc && bc.shadowRoot;
        if (!layoutEnabled || !sr) {
            clearCommentShadowState();
            return;
        }
        if (sr !== observedShadowRoot) {
            clearCommentShadowState();
            observedShadowRoot = sr;
            observeShadowRoot(sr);
            scanShadowNodes(sr.children);
            lastShadowScanAt = Date.now();
        }

        // 自定义元素可能晚于插入才挂载 shadow root；5 秒一次兜底发现这种节点。
        const now = Date.now();
        if (now - lastShadowScanAt >= 5000) {
            scanShadowNodes(sr.children);
            for (const [root, observer] of shadowObservers) {
                if (root.host && root.host.isConnected) continue;
                observer.disconnect();
                shadowObservers.delete(root);
                if (actionRoots.has(root)) forgetActionRoot(root);
            }
            lastShadowScanAt = now;
        }
        if (activeTab === 'comment') syncActionRoots();

        // 缓存命中直接返回；兼容没有 ShadowRoot.getElementById 的内核。
        if (shadowStyleEl && shadowStyleEl.isConnected && shadowStyleEl.parentNode === sr) return;
        const existing = sr.querySelector('#bctr-shadow-style');
        if (existing) { shadowStyleEl = existing; return; }
        const st = document.createElement('style');
        st.id = 'bctr-shadow-style';
        st.textContent = `bili-comment-box { padding-left: 8px !important; padding-right: 8px !important; }`;
        sr.appendChild(st);
        shadowStyleEl = st;
    }

    /* ================= 评论页签的滚动容器 =================
       与布局样式里 #commentapp 那段注释配套（B站评论组件靠"父元素 overflow-y 可滚动"来
       选择 scrollContainer 的机制）。这里统一给出"当前页签的滚动容器"，浮动滚动条 /
       评论懒加载触发都按它算 —— 评论页签的滚动器现在是 #commentapp，不再是外层 tabbody。 */

    // 评论页签的滚动容器：优先 #commentapp（它被搬进评论页签后由组件自己当滚动器），
    // 还没搬进来 / 没有评论容器时退回页签本体。
    // 只在滚动条、懒加载这类低频路径上调用，一次 getElementById 可以忽略。
    function getCommentScroller() {
        const app = document.getElementById('commentapp');
        const tab = getTabComment();
        if (app && tab && tab.contains(app)) return app;
        return tab;
    }

    function getActiveScroller() {
        return activeTab === 'intro' ? getTabIntro() : getCommentScroller();
    }

    /* ================= 自绘浮动滚动条（overlay 模式） =================
       原生滚动条被 scrollbar-width:none 完全隐藏（不留 10px 槽位、也没有轨道底色），
       这里按 tabbody 的滚动状态画一根浮动滑块：滚动/悬停时淡入，闲置自动淡出。
       容器仍是真正的滚动容器，滚轮、键盘、触摸滚动全部照常可用。 */

    let sbIdleTimer = 0;
    let sbDragging = false;
    // 指针停在滑块上：闲置淡出必须让路，否则鼠标刚移上去滑块就没了，永远抓不住
    let sbHover = false;
    // 上一次写进 DOM 的几何值：没变就不写，省掉无谓的样式失效
    const sbGeom = { body: null, top: -1, height: -1, scrollHeight: -1, thumbH: -1, y: -1 };

    function resetSbGeom() {
        sbGeom.body = null;
        sbGeom.top = sbGeom.height = sbGeom.scrollHeight = sbGeom.thumbH = sbGeom.y = -1;
    }

    // 高频滚动/resize 合帧计算，避免每个事件都同步读布局。
    // 非 overlay 模式的判定放在 updateOverlayScrollbar 内部（它会顺手清掉 .show），这里只管合帧。
    const scheduleOverlayUpdate = coalesceRaf(() => updateOverlayScrollbar(false));

    function showSbThumb() {
        const track = document.getElementById(CONFIG.sbTrackId);
        if (!track) return;
        if (getScrollbarMode() !== 'overlay') return;
        track.classList.add('show');
        clearTimeout(sbIdleTimer);
        sbIdleTimer = setTimeout(() => {
            if (!sbDragging && !sbHover) track.classList.remove('show');
        }, 900);
    }

    function hideSbThumb() {
        clearTimeout(sbIdleTimer);
        const track = document.getElementById(CONFIG.sbTrackId);
        if (track && !sbDragging && !sbHover) track.classList.remove('show');
    }

    function updateOverlayScrollbar(measureGeometry = true) {
        const track = document.getElementById(CONFIG.sbTrackId);
        const thumb = document.getElementById(CONFIG.sbThumbId);
        if (!track || !thumb) return;
        if (getScrollbarMode() !== 'overlay') { track.classList.remove('show'); return; }

        const body = getActiveScroller();
        if (!body) { track.classList.remove('show'); return; }
        // 未选中的「简介」页签是 0 高裁剪状态，没有滚动条可言；
        // 评论页签未选中时 #commentapp 也已经是 0 高，走下面的 sh<=ch 分支自动隐藏
        if (body === getTabIntro() && body.hidden) { track.classList.remove('show'); return; }

        const reuseGeometry = !measureGeometry && sbGeom.body === body && sbGeom.height >= 0;
        const sh = reuseGeometry ? sbGeom.scrollHeight : body.scrollHeight;
        const ch = reuseGeometry ? sbGeom.height : body.clientHeight;
        const top = reuseGeometry ? sbGeom.top : body.offsetTop;
        if (!reuseGeometry) {
            sbGeom.body = body;
            sbGeom.scrollHeight = sh;
        }
        // 轨道位置只在面板尺寸变化时才需要重写
        if (top !== sbGeom.top || ch !== sbGeom.height) {
            sbGeom.top = top;
            sbGeom.height = ch;
            track.style.top = top + 'px';
            track.style.height = ch + 'px';
        }
        if (sh <= ch + 1) { track.classList.remove('show'); return; }

        const thumbH = Math.max(28, Math.round(ch * ch / sh));
        const maxScroll = sh - ch;
        const y = Math.round((body.scrollTop / maxScroll) * (ch - thumbH));
        if (thumbH !== sbGeom.thumbH) {
            sbGeom.thumbH = thumbH;
            thumb.style.height = thumbH + 'px';
        }
        if (y !== sbGeom.y) {
            sbGeom.y = y;
            thumb.style.transform = 'translateY(' + y + 'px)';
        }
    }

    // 绑定一次：页签滚动 → 更新滑块；面板悬停 → 淡入淡出；滑块可拖动
    function initOverlayScrollbar(panel) {
        if (panel.dataset.sbBound) return;   // 只绑一次；先看标记，省掉一次 querySelector
        const thumb = panel.querySelector('#' + CONFIG.sbThumbId);
        if (!thumb) return;
        panel.dataset.sbBound = '1';
        resetSbGeom();                       // 面板是新建的，缓存的几何值作废
        sbHover = false;                     // 旧滑块被换掉时不会收到 mouseleave，悬停标记要清

        // scroll 事件不冒泡，但捕获阶段会经过祖先：在面板上挂一个捕获监听，
        // 就能收到所有后代滚动器的事件。评论页签的滚动器现在是 #commentapp，
        // 所以按"本页签的滚动容器"过滤，别把推荐列表等内部滚动也算进来。
        panel.addEventListener('scroll', (e) => {
            const t = e.target;
            if (t === getTabIntro() || t === getTabComment() || (t && t.id === 'commentapp')) {
                scheduleOverlayUpdate();
                showSbThumb();
            }
        }, { passive: true, capture: true });
        panel.addEventListener('mouseenter', () => { updateOverlayScrollbar(); showSbThumb(); });
        panel.addEventListener('mouseleave', hideSbThumb);

        // 悬停期间不许淡出（showSbThumb 的 900ms 计时器看 sbHover）；
        // 移开后重新起一次计时，恢复"闲置自动淡出"。
        thumb.addEventListener('mouseenter', () => { sbHover = true; showSbThumb(); });
        thumb.addEventListener('mouseleave', () => { sbHover = false; showSbThumb(); });

        thumb.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            const body = getActiveScroller();
            if (!body) return;
            e.preventDefault();
            e.stopPropagation();

            const ch = body.clientHeight;
            const maxScroll = Math.max(1, body.scrollHeight - ch);
            const trackRange = Math.max(1, ch - thumb.offsetHeight);
            const startY = e.clientY;
            const startTop = body.scrollTop;
            sbDragging = true;
            thumb.classList.add('dragging');
            document.body.style.userSelect = 'none';

            // 高回报率鼠标一秒能抛上百个 mousemove，统一合并到每帧一次
            let lastClientY = startY;
            const applyMove = coalesceRaf(() => {
                const dy = lastClientY - startY;
                body.scrollTop = Math.max(0, Math.min(maxScroll, startTop + dy * (maxScroll / trackRange)));
                // 滑块位置由 scrollTop 触发的 scroll 事件统一刷新，这里不用再算一遍
            });
            const onMove = (ev) => { lastClientY = ev.clientY; applyMove(); };
            const onUp = () => {
                sbDragging = false;
                thumb.classList.remove('dragging');
                document.body.style.userSelect = '';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                showSbThumb();
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    /* 单屏布局会触发B站离屏自动 PiP：锁住页面滚动、关闭自动 PiP，并退出已进入的小窗。
       全屏时全部让路。隔离世界 patch 不到页面原型，因此只使用跨世界有效的 DOM 属性和事件。 */

    const PIP_GESTURE_WINDOW = 3000; // ms：距上次真实用户操作超过这个时长，视为"自动"触发
    // data-screen 的合法取值：只有 mini（及未知值）需要复位，其余保持原样
    const PIP_NORMAL_SCREENS = ['normal', 'wide'];
    let lastUserInputAt = 0;

    function markUserInput() { lastUserInputAt = Date.now(); }

    function isUserInitiated() {
        return (Date.now() - lastUserInputAt) <= PIP_GESTURE_WINDOW;
    }

    // 把 document 及各布局容器的滚动位置钉回 0，杜绝"播放器被滚出视口"。
    // 快速路径：先只读一次全局滚动量；页面本来就不滚动时（99% 的体检）一个容器都不用碰，
    // 避免每秒白读 5 个元素的 scrollTop（那会强制一次布局）。
    function pinDocumentScroll() {
        if (!layoutEnabled || !layoutCanApply()) return;
        if (!window.scrollY && !document.documentElement.scrollTop && !document.body.scrollTop) return;
        if (document.documentElement.scrollTop) document.documentElement.scrollTop = 0;
        if (document.body.scrollTop) document.body.scrollTop = 0;
        const vdcon = getVdcon();
        if (vdcon && vdcon.scrollTop) vdcon.scrollTop = 0;
        const left = getLeftContainer();
        if (left && left.scrollTop) left.scrollTop = 0;
        const right = getRightContainer();
        if (right && right.scrollTop) right.scrollTop = 0;
    }

    // Chrome 的"自动画中画"开关挂在 video.autoPictureInPicture 上（B站"原生画中画"设置会把它置 true），
    // 页面一进入/切走就可能被浏览器自动拉进画中画。布局启用期间一律关掉。
    // 视频元素走缓存，不再每秒 querySelectorAll('video')。
    // 全屏期间不碰：那时"原生画中画"该由B站自己的设置决定（退出全屏后下一次体检补上）。
    function disableAutoPipFlag() {
        if (!layoutEnabled || !layoutCanApply()) return;
        if (isPlayerFullscreen()) return;
        const vids = getVideoEls();
        for (const v of vids) {
            try {
                if (v.autoPictureInPicture) {
                    v.autoPictureInPicture = false;
                    log('已关闭 video.autoPictureInPicture（浏览器自动画中画）');
                }
            } catch (e) { /* 忽略 */ }
        }
    }

    // 已经掉进小窗/画中画里就拉回来（全屏期间不干这事，见上面的 ⚠）
    function exitAutoMiniPip() {
        if (!layoutEnabled || !layoutCanApply()) return false;
        if (isPlayerFullscreen()) return false;
        let recovered = false;
        const auto = !isUserInitiated();

        // ① 原生画中画
        if (document.pictureInPictureElement && auto) {
            try {
                const p = document.exitPictureInPicture();
                if (p && p.catch) p.catch(() => {});
                recovered = true;
                log('已退出自动开启的原生画中画');
            } catch (e) { /* 忽略 */ }
        }

        // ② B站迷你播放器（小窗）：data-screen="mini" 时容器变成 fixed 小窗，
        //    双击全屏失效、整窗可拖。优先走B站自己的开关（.mini-player-window.on），
        //    再兜底直接复位属性并清掉内联定位/尺寸。
        const pc = getPlayerContainer();
        if (pc && auto) {
            const screen = pc.getAttribute('data-screen');
            const miniBtn = getMiniPlayerBtn();
            const miniOn = !!(miniBtn && /\bon\b/.test(miniBtn.className));
            if (screen === 'mini' || miniOn) {
                if (miniOn && miniBtn) {
                    try { miniBtn.click(); } catch (e) { /* 忽略 */ }
                }
                if (pc.getAttribute('data-screen') === 'mini') {
                    pc.setAttribute('data-screen', 'normal');
                    pc.style.position = '';
                    pc.style.width = '';
                    pc.style.height = '';
                    pc.style.top = '';
                    pc.style.left = '';
                    pc.style.right = '';
                    pc.style.bottom = '';
                }
                recovered = true;
                log('检测到小窗/迷你播放模式，已复位为正常模式');
            } else if (screen && PIP_NORMAL_SCREENS.indexOf(screen) === -1) {
                pc.setAttribute('data-screen', 'normal');
                recovered = true;
                log('播放器屏幕模式被改成', screen, '，已复位为 normal');
            }
        }

        if (recovered) {
            disableAutoPipFlag();
            pinDocumentScroll();
            updatePlayerLayout(true);
            scheduleFollowUpResizes();
        }
        return recovered;
    }

    /* ================= 滚轮调音量 =================
       需求：鼠标停在播放画面上时，滚轮 = 音量加减（和客户端的手感一致）。
       几个关键决定：
       ① 只在「客户端双栏布局」下接管（layoutEnabled）：单屏布局里页面本来就不滚动，
          preventDefault 没有任何副作用；一旦用 ⇄ 切回B站原布局，播放器区域的滚轮还给B站
          ——原布局下页面要靠滚轮往下看评论，抢掉会很难受。
       ② 播放器进入全屏后一律让路：B站「全屏」（data-screen="full"）、「网页全屏」
          （data-screen="web"）以及浏览器原生全屏下，B站播放器自带滚轮调音量，
          脚本直接放行——不 preventDefault、不 stopPropagation，交给B站自己处理，
          免得两边各调一次（"一格滚两下"）；脚本自己的中央提示条也不再出现。
       ③ 捕获阶段监听 + preventDefault + stopPropagation（只在非全屏时）：
          · preventDefault  —— 不让页面 / 祖先容器跟着滚；
          · stopPropagation —— 不让播放器 / B站再调一次音量，避免一格滚两下。
       ④ 一格 = wheelVolumeStep%（默认 5%）；触控板那种每个事件只有几像素的 delta 先累积，
          攒够一格才动作，否则轻轻一滑音量就到底。
       ⑤ 直接写 <video>.volume / <video>.muted：跨播放器版本最可靠的入口，
          改完 volumechange 照常派发，B站自己的音量状态也会读到新值；不碰播放器内部 API。
       ⚠ 音量写在当前 <video> 元素上，而B站另存了一份自己的音量记忆，
         切视频 / 刷新后可能回到它记的那个值——这是B站的行为，不是脚本失效。 */

    function normalizeWheelStep(v) {
        v = Math.round(Number(v));
        if (!isFinite(v) || v <= 0) return CONFIG.wheelVolume.defaultStep;
        return Math.min(CONFIG.wheelVolume.maxStep, Math.max(CONFIG.wheelVolume.minStep, v));
    }

    // 指针是否落在播放画面上（穿过 Shadow DOM 也能认出来）。
    // 面板 / 推荐列表这些地方的滚轮不受影响，照常滚动。
    function isPointerOnPlayer(target) {
        let el = (target && target.nodeType === 1) ? target : ((target && target.parentElement) || null);
        while (el) {
            if (el.matches && el.matches(CONFIG.playerWheelScope)) return true;
            // 播放器组件若用了 Shadow DOM，parentElement 会断在 shadow root，改走 host
            const root = el.getRootNode ? el.getRootNode() : null;
            el = el.parentElement || (root && root.host) || null;
        }
        return false;
    }

    // 当前音量（0~1）：静音按 0 算，这样"静音状态下往上滚"能自然地恢复出声
    function currentVideoVolume(video) {
        if (!video) return 0;
        return video.muted ? 0 : video.volume;
    }

    function applyVideoVolume(percent) {
        const video = getWheelVideoEl();
        if (!video) return;
        const v = Math.max(0, Math.min(1, percent / 100));
        if (v > 0 && video.muted) video.muted = false;   // 先解除静音，否则写了音量也没声
        video.volume = v;
        if (v === 0) video.muted = true;                 // 滚到 0 就静音，和B站控制条行为一致
        showVolumeOsd(Math.round(v * 100));
        log('滚轮调音量:', Math.round(v * 100) + '%');
    }

    // 播放器是否处于「全屏」：B站全屏（data-screen="full"）/ 网页全屏（data-screen="web"）
    // 与浏览器原生全屏都算。这是「全屏期间让路给B站」的唯一判据，三处在用：
    //   · 滚轮调音量（见上面 ②）—— 播放器全屏时B站自带，脚本不接管；
    //   · 画中画 / 小窗守卫 —— 全屏时不动 video.autoPictureInPicture、不强制退出 PiP/小窗；
    //   · html.bctr-player-fs 类 —— 全屏时不再用 !important 压B站对播放器链路的排版。
    // 小窗 mini / 宽屏 wide / 普通 normal 都不算全屏，仍由脚本接管。
    function isPlayerFullscreen() {
        if (document.fullscreenElement || document.webkitFullscreenElement) return true;
        const pc = getPlayerContainer();
        if (!pc) return false;
        const screen = pc.getAttribute('data-screen');
        return screen === 'full' || screen === 'web';
    }

    /* ---- 把"播放器全屏中"镜像成 <html> 上的一个类 ----
       isPlayerFullscreen() 给 JS 分支用；CSS 也要知道当前是不是全屏：
       #bilibili-player / .bpx-docker 是 .bpx-player-container 的祖先，纯 CSS 子选择器够不到
       （除非用 :has() 反查，老内核没有），所以由 JS 写类、样式写成 html:not(.bctr-player-fs) …。
       进入/退出都是事件驱动（data-screen 属性变化 + fullscreenchange），没有"已进全屏但样式
       还压着B站"的延迟窗口；tick 里再补一次，兜住 MutationObserver 不可用的内核。 */
    let fsMirrorObserver = null;
    let fsMirrorState = null;   // 已经写到 <html> 上的状态（null = 还没写过）
    const FS_CLASS = 'bctr-player-fs';

    function syncFullscreenClass() {
        const on = isPlayerFullscreen();
        if (on === fsMirrorState) return;
        fsMirrorState = on;
        document.documentElement.classList.toggle(FS_CLASS, on);
    }

    function installFullscreenMirror() {
        if (!fsMirrorObserver && window.MutationObserver && document.body) {
            fsMirrorObserver = new MutationObserver(syncFullscreenClass);
            document.addEventListener('fullscreenchange', syncFullscreenClass);
            document.addEventListener('webkitfullscreenchange', syncFullscreenClass);
            // 观察整棵 body 子树的 data-screen：B站把播放器容器整个换掉也不用重新挂观察器
            try {
                fsMirrorObserver.observe(document.body,
                    { subtree: true, attributes: true, attributeFilter: ['data-screen'] });
            } catch (e) { fsMirrorObserver = null; }
        }
        syncFullscreenClass();
    }

    function onPlayerWheel(e) {
        if (!wheelVolumeEnabled || !layoutEnabled) return;
        if (!isPointerOnPlayer(e.target) || !layoutCanApply()) return;
        // 横向滚轮（触控板左右滑）不碰音量，也不拦，留给B站/浏览器
        if (!e.deltaY || Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
        // 全屏：完全放行给B站自带的滚轮音量，顺手清掉累积量，
        // 免得退出全屏后第一格先补上全屏期间攒下的零头
        if (isPlayerFullscreen()) { wheelAccum = 0; return; }
        const video = getWheelVideoEl();
        if (!video) return;

        e.preventDefault();
        e.stopPropagation();   // 非全屏下也不让播放器/B站再调一次，避免一格滚两下

        // deltaMode：0=像素（Chrome/Edge）1=行（Firefox）2=页，先统一折算成像素
        const notch = CONFIG.wheelVolume.notchPx;
        const unit = e.deltaMode === 1 ? 40 : (e.deltaMode === 2 ? notch * 4 : 1);
        const delta = e.deltaY * unit;
        // 方向反转：不欠上一方向的量，否则"往上滚再往下滚"会先补回上一步
        if (wheelAccum !== 0 && (wheelAccum > 0) !== (delta > 0)) wheelAccum = 0;
        wheelAccum += delta;
        const steps = Math.trunc(wheelAccum / notch);
        if (!steps) return;                    // 还没攒够一格（触控板常见）
        wheelAccum -= steps * notch;
        // steps 为负 = 向上滚 = 音量变大，与B站播放器滚轮方向的默认手感一致
        applyVideoVolume(currentVideoVolume(video) * 100 - steps * wheelVolumeStep);
    }

    /* 音量提示条：改的是 <video> 原生音量，B站不一定给视觉反馈，这里在画面中央
       弹一个自绘小条，CONFIG.wheelVolume.osdHideDelay 后自己淡出。
       只服务非全屏场景——全屏 / 网页全屏下脚本不接管滚轮，音量指示由B站自带的负责，
       所以提示条固定挂 body、按播放器盒子居中即可，不需要"全屏宿主"那套切换。 */
    function showVolumeOsd(percent) {
        if (!wheelVolumeOsd) return;
        if (!wheelOsdEl || !wheelOsdEl.isConnected) {
            wheelOsdEl = document.createElement('div');
            wheelOsdEl.id = CONFIG.wheelVolume.osdId;
            wheelOsdV = -1;
        }
        const host = document.body || document.documentElement;
        if (wheelOsdEl.parentNode !== host) host.appendChild(wheelOsdEl);
        if (wheelOsdV !== percent) {
            wheelOsdV = percent;
            wheelOsdEl.textContent = (percent === 0 ? '🔇 ' : '🔊 ') + percent + '%';
        }
        const box = getPlayerContainer() || document.getElementById('playerWrap');
        if (box) {
            const r = box.getBoundingClientRect();
            wheelOsdEl.style.left = Math.round(r.left + r.width / 2) + 'px';
            wheelOsdEl.style.top = Math.round(r.top + r.height / 2) + 'px';
        }
        wheelOsdEl.classList.add('show');
        clearTimeout(wheelOsdTimer);
        wheelOsdTimer = setTimeout(hideVolumeOsd, CONFIG.wheelVolume.osdHideDelay);
    }

    function hideVolumeOsd() {
        clearTimeout(wheelOsdTimer);
        if (wheelOsdEl) wheelOsdEl.classList.remove('show');
    }

    /* ================= 布局开关 ================= */

    function setLayoutEnabled(on, persist) {
        layoutEnabled = !!on;
        if (!layoutEnabled) layoutGraceUntil = 0;
        buildLayoutStyle();
        applyWidths();
        if (layoutEnabled) {
            ensurePanel();
            syncPanelContents();
        } else {
            teardownPanel();
        }
        syncDragHandle();   // 关闭布局时手柄一并撤掉，别在B站原布局上留一条隐形拖拽带
        syncToggleButtonState(toggleBtn);
        markGeometryDirty();
        updateOverlayScrollbar();
        pinDocumentScroll();
        exitAutoMiniPip();
        if (!layoutEnabled || layoutCanApply()) {
            updatePlayerLayout(true);
            scheduleFollowUpResizes();
        }
        if (layoutEnabled && layoutCanApply()) positionHandle();
        hideVolumeOsd();    // 关掉布局后滚轮不再调音量，提示条也别留着
        wheelAccum = 0;
        if (persist) GM_setValue('clientLayout', layoutEnabled);
        log('布局:', layoutEnabled ? '客户端双栏' : 'B站原布局');
    }

    /* ================= 播放器同步 ================= */

    function updatePlayerLayout(force) {
        const now = Date.now();
        if (!force && now - lastResizeNotify < 100) return;
        lastResizeNotify = now;
        window.dispatchEvent(new Event('resize'));
    }

    // 用两个定时器 id 保存，重复调度时先清旧的，避免快速切换布局时 setTimeout 堆积
    let followUpTimer1 = 0, followUpTimer2 = 0;
    function scheduleFollowUpResizes() {
        clearTimeout(followUpTimer1);
        clearTimeout(followUpTimer2);
        followUpTimer1 = setTimeout(() => updatePlayerLayout(true), 250);
        followUpTimer2 = setTimeout(() => updatePlayerLayout(true), 700);
    }

    /* ================= 右栏宽度拖拽 ================= */

    let dragBubble = null;      // 手柄上的百分比气泡，建手柄时缓存，省掉拖拽中的 querySelector
    let animTimer = 0;          // 一次性宽度过渡的收尾定时器

    // 双击复位 / 菜单复位这类"跳变"给 180ms 过渡；拖拽时绝不能带过渡（会跟手不上）
    function animateWidthOnce() {
        if (isDragging) return;
        document.documentElement.classList.add('bctr-anim');
        clearTimeout(animTimer);
        animTimer = setTimeout(() => document.documentElement.classList.remove('bctr-anim'), 240);
    }

    function setRightPercent(p, persist) {
        rightPercent = clampPercent(p);
        applyWidths();
        lastResizeNotify = 0;
        if (isDragging) {
            // 拖拽中只改宽度：手柄挂在面板左边缘，宽度一变它自己就跟过去了，
            // 每帧既不用读 getBoundingClientRect，也不用再写 left
            updatePlayerLayout(false);
        } else {
            animateWidthOnce();
            updatePlayerLayout(true);
            scheduleFollowUpResizes();
        }
        if (dragHandle) {
            const label = Math.round(rightPercent) + '%';
            if (dragBubble && dragBubble.textContent !== label) dragBubble.textContent = label;
            // title 是悬停提示，拖拽中不会显示，没必要每帧重算字符串
            if (!isDragging) {
                const title = `拖拽调整右栏宽度（当前 ${label}），双击重置为 ${CONFIG.styleSettings.defaultRightPercent}%`;
                if (dragHandle.title !== title) dragHandle.title = title;
            }
        }
        if (persist) GM_setValue('rightWidthPercent', rightPercent);
    }

    // 手柄随面板左边缘移动；只需在面板重建后补挂，不必测量位置。
    function positionHandle() {
        if (!dragHandle || !layoutEnabled) return;
        const panel = getPanel();
        if (!panel) return;
        if (dragHandle.parentNode !== panel) panel.appendChild(dragHandle);
    }

    // Pointer Capture 保证指针移出窗口或播放器后拖拽事件不丢失。
    function onDragStart(e) {
        if (!dragHandle || (e.button !== undefined && e.button !== 0)) return;
        const vdcon = getVdcon();
        if (!vdcon) return;
        e.preventDefault();
        e.stopPropagation();

        // 拖拽期间 #mirror-vdcon 的宽度不会变，几何量一次性预取。
        // 布局样式已把 vdcon 的 padding 强制为 0，无需再读 computedStyle 取内边距。
        const vr = vdcon.getBoundingClientRect();
        dragContentW = Math.max(1, vr.width);
        dragContentRight = vr.right;

        isDragging = true;
        document.documentElement.classList.remove('bctr-anim');   // 拖拽不要过渡
        dragHandle.classList.add('dragging');
        document.documentElement.classList.add('bctr-dragging');
        try { dragHandle.setPointerCapture(e.pointerId); } catch (err) { /* 老内核忽略 */ }
        // 指针被 handle 捕获后，move/up 都会回到 handle 上，不必再挂 document
        dragHandle.addEventListener('pointermove', onDragMove);
        dragHandle.addEventListener('pointerup', onDragEnd);
        dragHandle.addEventListener('pointercancel', onDragEnd);
        dragHandle.addEventListener('lostpointercapture', onDragEnd);
    }

    let dragLastX = 0;
    // 每帧最多改一次宽度：pointermove 只记录坐标，实际计算合帧执行
    const dragCoalesced = coalesceRaf(() => {
        if (isDragging) setRightPercent((dragContentRight - dragLastX) / dragContentW * 100, false);
    });

    function onDragMove(e) {
        dragLastX = e.clientX;
        dragCoalesced();
    }

    function onDragEnd() {
        if (!isDragging) return;
        isDragging = false;
        if (dragHandle) {
            dragHandle.classList.remove('dragging');
            dragHandle.removeEventListener('pointermove', onDragMove);
            dragHandle.removeEventListener('pointerup', onDragEnd);
            dragHandle.removeEventListener('pointercancel', onDragEnd);
            dragHandle.removeEventListener('lostpointercapture', onDragEnd);
        }
        document.documentElement.classList.remove('bctr-dragging');
        setRightPercent(rightPercent, true); // 落盘并同步手柄。
        log('右栏宽度已保存:', Math.round(rightPercent) + '%');
    }

    // 手柄只在客户端布局下存在：切回B站原布局时必须撤掉，
    // 否则那条 16px 宽的隐形 col-resize 热区会盖在两栏之间抢点击。
    function syncDragHandle() {
        if (!layoutEnabled) {
            if (dragHandle) {
                dragHandle.remove();
                dragHandle = null;
                dragBubble = null;
            }
            return;
        }
        // 补全完成前不插手柄（B站的对位会把多余节点当成结构不一致 → 整页重渲染）
        if (!shellInjectionOk) return;
        if (dragHandle && dragHandle.isConnected) return;
        createDragHandle();
    }

    function createDragHandle() {
        const panel = getPanel();
        if (!panel) return;
        const stale = document.getElementById(CONFIG.dragHandleId);
        if (stale) stale.remove();   // SPA 跳转后可能残留一个没绑事件的旧手柄

        dragHandle = document.createElement('div');
        dragHandle.id = CONFIG.dragHandleId;
        dragHandle.innerHTML = `
            <div class="bctr-handle-line"></div>
            <div class="bctr-handle-bubble"></div>
        `;
        dragBubble = dragHandle.querySelector('.bctr-handle-bubble');
        dragHandle.addEventListener('pointerdown', onDragStart);
        dragHandle.addEventListener('dblclick', (e) => {
            e.preventDefault();
            setRightPercent(CONFIG.styleSettings.defaultRightPercent, true);
        });

        panel.appendChild(dragHandle);          // 挂在面板左边缘，跟着面板走
        setRightPercent(rightPercent, false);   // 顺带写好 title 与气泡文案；样式在常驻样式表里
    }

    /* ================= 切换按钮 / 菜单 ================= */

    function toggleBtnTitle() {
        return layoutEnabled ? '切回B站原布局' : '启用客户端双栏布局';
    }

    // 按钮的无障碍状态跟着布局开关走（title 同时是鼠标悬停提示）
    function syncToggleButtonState(btn) {
        if (!btn) return;
        const title = toggleBtnTitle();
        if (btn.title !== title) btn.title = title;
        btn.setAttribute('aria-label', title);
        btn.setAttribute('aria-pressed', layoutEnabled ? 'true' : 'false');
    }

    // 按钮常驻，但 /video/ 与 /list/ 的挂载点不同；
    // 用 dataset.pageType 记录按钮属于哪一类页面，SPA 切换后若类型不匹配就重建，
    // 避免按钮遗留在上一页面的工具栏里错位。
    function createToggleButton() {
        const pageType = isListPage() ? 'list' : 'video';
        if (toggleBtn && toggleBtn.isConnected) {
            if (toggleBtn.dataset.pageType === pageType) return;
            toggleBtn.remove();               // 页面类型变了（/video/ ↔ /list/），换挂载点重建
            toggleBtn = null;
        }
        // 补全完成前不往B站工具栏里插按钮；原布局下不需要等（按钮是切回来的唯一入口）
        if (layoutEnabled && !shellInjectionOk) return;

        // 挂载点也缓存：每秒一次 querySelector 换成引用比较
        let mount = nodeCache.toggleMount;
        if (!mount || !mount.isConnected || nodeCache.toggleMountType !== pageType) {
            // 不存在的挂载点走负缓存，避免体检反复查询。
            if (nodeCache.toggleMountType === pageType && !mount && missCooling('toggleMount')) return;
            const isList = pageType === 'list';
            mount = document.querySelector(
                isList ? CONFIG.playlistToolbarRightSelector : CONFIG.toolbarRightSelector);
            // /list/ 页没有右侧组，挂到工具条本体末尾（靠 margin-left:auto 贴右）
            nodeCache.toggleMountInBar = !mount;
            if (!mount) {
                mount = document.querySelector(
                    isList ? CONFIG.playlistToolbarSelector : CONFIG.toolbarSelector);
            }
            nodeCache.toggleMount = mount;
            nodeCache.toggleMountType = pageType;
            rememberLookup('toggleMount', !!mount);
        }
        if (!mount) return;

        toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'comment-toggle-btn'
            + (nodeCache.toggleMountInBar ? ' bctr-toggle-in-bar' : '');
        toggleBtn.dataset.pageType = pageType;
        toggleBtn.textContent = '⇄';
        syncToggleButtonState(toggleBtn);
        toggleBtn.addEventListener('click', () => {
            setLayoutEnabled(!layoutEnabled, true);
        });

        mount.appendChild(toggleBtn);
    }

    function registerSettingsMenu() {
        GM_registerMenuCommand("⚙️ 切换：客户端双栏 / B站原布局", function() {
            setLayoutEnabled(!layoutEnabled, true);
        });
        GM_registerMenuCommand("⚙️ 右栏宽度：重置为默认", function() {
            setRightPercent(CONFIG.styleSettings.defaultRightPercent, true);
        });
        GM_registerMenuCommand("⚙️ 页签：默认打开「评论」/ 记住上次（点击切换）", function() {
            rememberTab = !rememberTab;
            GM_setValue('rememberTab', rememberTab);
            if (rememberTab) GM_setValue('activeTab', activeTab);
            alert(rememberTab
                ? '已改为：记住上次打开的页签（当前：' + (activeTab === 'intro' ? '简介' : '评论') + '）'
                : '已改回：每次打开视频都默认停在「评论」页签（本脚本的初衷）');
        });
        GM_registerMenuCommand("⚙️ 面板滚动条：仅滑块 / 透明细条 / 隐藏 / 系统默认（点击切换）", function() {
            const cur = getScrollbarMode();
            const next = setScrollbarMode(
                SCROLLBAR_MODES[(SCROLLBAR_MODES.indexOf(cur) + 1) % SCROLLBAR_MODES.length]);
            buildLayoutStyle();
            resetSbGeom();          // 样式换了，缓存的几何值作废
            markGeometryDirty();
            updateOverlayScrollbar();
            showSbThumb();
            alert('面板滚动条已切换为：' + SCROLLBAR_LABELS[next] + '（已立即生效）');
        });
        GM_registerMenuCommand("⚙️ 滚轮调音量（鼠标停在画面上）：开 / 关", function() {
            wheelVolumeEnabled = !wheelVolumeEnabled;
            GM_setValue('wheelVolume', wheelVolumeEnabled);
            wheelAccum = 0;
            hideVolumeOsd();
            alert(wheelVolumeEnabled
                ? '已开启：客户端双栏布局下，鼠标停在播放画面上滚动滚轮 = 调音量（每格 '
                    + wheelVolumeStep + '%）；播放器全屏 / 网页全屏时由B站自带的滚轮音量接管'
                : '已关闭：播放器区域的滚轮不再改音量');
        });
        GM_registerMenuCommand("⚙️ 滚轮调音量的步长：2% / 5% / 10% / 20%（点击切换）", function() {
            const steps = CONFIG.wheelVolume.steps;
            const i = steps.indexOf(wheelVolumeStep);
            wheelVolumeStep = steps[(i + 1) % steps.length];   // 当前值不在列表里时 i=-1 → 取第一个
            GM_setValue('wheelVolumeStep', wheelVolumeStep);
            wheelAccum = 0;
            alert('滚轮每格调整音量：' + wheelVolumeStep + '%');
        });
        GM_registerMenuCommand("⚙️ 滚轮调音量时的画面中央提示：开 / 关", function() {
            wheelVolumeOsd = !wheelVolumeOsd;
            GM_setValue('wheelVolumeOsd', wheelVolumeOsd);
            if (!wheelVolumeOsd) hideVolumeOsd();
            alert(wheelVolumeOsd ? '已开启音量提示条' : '已关闭音量提示条（音量照常可调）');
        });
    }

    /* ================= 节点防丢失自愈 =================
       B站前端重渲染偶尔会吞掉被我们搬移的节点；缓存原位置，发现父容器还在、
       节点却不在文档里就插回去。
       快速路径：缓存里的节点仍在正确父容器里就直接跳过——常态下每条规则零查询。 */
    function guardNodesOnce() {
        if (!layoutEnabled) return;
        safeDOMOperation(() => {
            for (const g of GUARD_RULES) {
                const cached = guardCache.get(g.sel);
                if (cached && cached.node && cached.node.isConnected
                    && cached.parent && cached.parent.isConnected
                    && cached.node.parentNode === cached.parent) {
                    continue;                            // 一切正常，不用碰文档
                }
                // 退避：这个视频本来就没有该模块（比如没有弹幕列表）时，别每秒白查两次；
                // 而"曾经认领到、现在丢了"的前几次仍然每次都查，保证自愈不迟到。
                const fails = cached ? (cached.fails || 0) : 0;
                const backoffReady = (!cached || !cached.node)
                    ? fails >= 1
                    : fails >= CONFIG.healer.guardFastRetries;
                if (backoffReady && tickCount < (cached.retryAt || 0)) continue;

                const parent = document.querySelector(g.parent);
                if (!parent) {
                    guardCache.set(g.sel, { node: cached && cached.node, fails: fails + 1,
                        retryAt: tickCount + CONFIG.healer.guardRetryTicks });
                    continue;
                }
                const live = parent.querySelector(g.sel);
                if (live) {
                    guardCache.set(g.sel, { node: live, parent, next: live.nextSibling });
                    continue;
                }
                const node = cached && cached.node;
                if (node && !document.body.contains(node) && document.body.contains(parent)) {
                    const next = cached.next && cached.next.parentNode === parent ? cached.next : null;
                    insertNode(node, parent, next);
                    guardCache.set(g.sel, { node, parent, next });
                    log('节点被B站重渲染吞掉，已自愈恢复:', g.sel);
                } else {
                    guardCache.set(g.sel, { node, parent, fails: fails + 1,
                        retryAt: tickCount + CONFIG.healer.guardRetryTicks });
                }
            }
        });
    }

    // 仅 /list/ 禁用标题跳转；缓存节点，避免体检重复查询。
    let titleLinkEl = null;

    function disableTitleLink() {
        if (!isListPage()) return;
        let link = titleLinkEl;
        if (!link || !link.isConnected) {
            if (!link && missCooling('titleLink')) return;   // 这页没有这个链接：负缓存内不再查
            link = titleLinkEl = rememberLookup('titleLink',
                document.querySelector(CONFIG.playlistTitleLinkSelector));
        }
        if (!link || link.dataset.bctrUnlinked) return;
        link.dataset.bctrUnlinked = '1';
        link.removeAttribute('href');
        link.style.cursor = 'default';
        link.style.textDecoration = 'none';
        link.style.color = 'inherit';
    }

    // 仅做引用与连接状态检查，并补回被B站重渲染删除的样式和控件。
    function ensureOwnNodes() {
        ensureStaticStyle();          // 常驻样式（拖拽手柄 / ⇄ 按钮 / 音量提示条）
        ensureLayoutStyle();          // 客户端布局总样式
        createToggleButton();         // ⇄ 按钮（原布局下也要能切回来）
        syncDragHandle();             // 拖拽手柄（仅客户端布局）
        syncCommentShadowStyle();     // 评论 shadow 内边距压缩
    }

    // 布局样式被B站重渲染删掉时补回来：锚点不完整时保持空样式，页面继续用B站原布局。
    function ensureLayoutStyle() {
        if (!layoutEnabled) return;
        if (!layoutVisualsCanApply()) {
            if (layoutStyleEl) layoutStyleEl.textContent = '';
            return;
        }
        if (layoutStyleEl && layoutStyleEl.isConnected && layoutStyleEl.textContent) return;
        buildLayoutStyle();
    }

    /* ================= SPA 路由与页面壳观察 ================= */

    function routeHasChanged() {
        return window.location.pathname !== lastRoutePath || window.location.search !== lastRouteSearch;
    }

    function syncRouteComment() {
        if (!layoutEnabled || !routeShellPending) return false;
        const commentBody = getTabComment();
        const vdcon = getVdcon();
        if (!commentBody || !vdcon) return false;
        const commentApp = vdcon.querySelector(CONFIG.commentAppSelector);
        if (!commentApp || !commentApp.querySelector('bili-comments')) return false;
        if (commentBody.contains(commentApp)) return false;
        moveCommentAppIntoPanel(commentApp, commentBody);
        if (resetCommentScrollOnReady) {
            if (commentApp !== routeOldCommentApp) commentApp.scrollTop = 0;
            resetCommentScrollOnReady = false;
        }
        removeWaitHint(commentBody);
        switchTab(activeTab, true);
        triggerCommentLazyLoad();
        syncCommentShadowStyle();
        return true;
    }

    function settleRouteShell() {
        if (!routeShellPending) return;
        const current = getVdcon();
        const left = getLeftContainer();
        const right = getRightContainer();
        const currentCommentApp = current && current.querySelector(CONFIG.commentAppSelector);
        const newCommentReady = routeOldCommentApp && currentCommentApp
            && currentCommentApp !== routeOldCommentApp
            && !!currentCommentApp.querySelector('bili-comments');
        const shellChanged = !current || current !== routeOldVdcon
            || (left && left !== routeOldLeft) || (right && right !== routeOldRight);
        if (shellChanged && routeReusedCommentApp
            && (!current || !current.contains(routeReusedCommentApp))) {
            const reused = routeReusedCommentApp;
            routeReusedCommentApp = null;
            const commentBody = getTabComment();
            if (commentBody && reused.parentNode === commentBody) {
                reused.remove();
                clearCommentShadowState();
                ensureWaitHint();
            }
        }
        if (shellChanged || newCommentReady || Date.now() >= routeShellDeadline) {
            routeShellPending = false;
            routeOldVdcon = routeOldLeft = routeOldRight = null;
            markGeometryDirty();
        }
    }

    function handleRouteChange() {
        const oldVdcon = getVdcon();
        const oldLeft = getLeftContainer();
        const oldRight = getRightContainer();
        const oldCommentBody = getTabComment();
        const oldCommentApp = oldCommentBody && oldCommentBody.querySelector(CONFIG.commentAppSelector);
        // DOM 可能先于 pushState 更新；用上一次观察到的壳作比较，避免把新壳误判成旧壳再空等。
        const observedShell = observedVdcon || observedLeft || observedRight;
        const restoreLeft = observedShell ? observedLeft : oldLeft;
        const restoreRight = observedShell ? observedRight : oldRight;
        const keepLayout = layoutEnabled && layoutVisualsCanApply();
        lastRoutePath = window.location.pathname;
        lastRouteSearch = window.location.search;
        routeReusedCommentApp = null;
        if (layoutEnabled) {
            if (keepLayout) resetPanelForRoute({ left: restoreLeft, right: restoreRight });
            else teardownPanel({ left: restoreLeft, right: restoreRight });
        } else restoreAllMoved();
        layoutGraceUntil = keepLayout ? Date.now() + CONFIG.routeLayoutGraceMs : 0;

        elCache.vdcon = elCache.left = elCache.right = null;
        elCache.panel = elCache.tabIntro = elCache.tabComment = null;
        dropNodeCache();
        guardCache.forEach((rec, key) => { if (!rec.node || !rec.node.isConnected) guardCache.delete(key); });
        titleLinkEl = null;
        resetCommentScrollOnReady = true;
        routeOldVdcon = observedShell ? (observedVdcon || oldVdcon) : oldVdcon;
        routeOldLeft = restoreLeft;
        routeOldRight = restoreRight;
        routeOldCommentApp = oldCommentApp;
        routeShellPending = !!(routeOldVdcon || routeOldLeft || routeOldRight);
        routeShellDeadline = Date.now() + 1500;
        wheelAccum = 0;
        hideVolumeOsd();
        syncLayoutObservers();
        applyWidths();
        markGeometryDirty();
    }

    let routeObserver = null;
    const checkRouteAndShell = coalesceRaf(() => {
        if (document.hidden) return;
        settleRouteShell();
        if (routeHasChanged()) {
            handleRouteChange();
            return;
        }
        if (layoutEnabled && routeShellPending && syncRouteComment()) return;
        // 评论组件挂载会改变 #commentapp 的子树，立即重试搬迁，不必等下一秒体检。
        if (layoutEnabled && (!getPanel() || movesPending) && ensurePanel()) syncPanelContents();
    });

    function isUrgentRouteNode(node) {
        if (node.nodeType !== 1) return false;
        return node.id === 'mirror-vdcon' || node.id === 'playerWrap' || node.id === 'commentapp'
            || node.localName === 'bili-comments'
            || node.classList.contains('left-container') || node.classList.contains('right-container')
            || !!node.querySelector('#mirror-vdcon, .left-container, .right-container, #playerWrap, #commentapp, bili-comments');
    }

    function routeMutationIsUrgent(records) {
        for (const record of records) {
            for (const nodes of [record.addedNodes, record.removedNodes]) {
                for (const node of nodes) if (isUrgentRouteNode(node)) return true;
            }
        }
        return false;
    }

    function installRouteObserver() {
        if (window.MutationObserver) {
            let pendingScanTimer = 0;
            let lastPendingScanAt = 0;
            routeObserver = new MutationObserver((records) => {
                if (records.some((record) => record.target.id === 'commentapp')) resetSbGeom();
                if (!movesPending) {
                    clearTimeout(pendingScanTimer);
                    pendingScanTimer = 0;
                    checkRouteAndShell();
                    return;
                }
                const elapsed = performance.now() - lastPendingScanAt;
                if (routeMutationIsUrgent(records) || !lastPendingScanAt || elapsed >= 100) {
                    clearTimeout(pendingScanTimer);
                    pendingScanTimer = 0;
                    lastPendingScanAt = performance.now();
                    checkRouteAndShell();
                } else if (!pendingScanTimer) {
                    pendingScanTimer = setTimeout(() => {
                        pendingScanTimer = 0;
                        lastPendingScanAt = performance.now();
                        checkRouteAndShell();
                    }, 100 - elapsed);
                }
            });
            routeObserver.observe(document.documentElement, { childList: true, subtree: true });
        }
        window.addEventListener('popstate', checkRouteAndShell);
        window.addEventListener('hashchange', checkRouteAndShell);
        window.addEventListener('pageshow', checkRouteAndShell);
    }

    /* ================= 定时体检 =================
       1 秒一次的自愈循环。原则：常态下只做「零文档查询」的廉价检查，
       只有发现异常（面板被B站吞掉、SPA 换了视频）才付出全量扫描的代价。 */

    function tick() {
        if (document.hidden) return;   // 后台标签页不干活；回到前台会立刻补一次（见 visibilitychange）

        settleRouteShell();
        // B站是 SPA：换视频不会重跑脚本，路由事件与 DOM 观察都会走这里。
        const routeChanged = routeHasChanged();
        if (routeChanged) handleRouteChange();

        disableTitleLink();            // 仅 /list/ 页面有效，幂等
        syncFullscreenClass();         // 全屏状态镜像（事件之外的兜底：一次属性读，值没变就返回）
        const playerFs = fsMirrorState === true;

        if (layoutEnabled && !layoutVisualsCanApply()) {
            teardownPanel();
            if (layoutStyleEl) layoutStyleEl.textContent = '';
            applyWidths();
        }

        if (layoutEnabled && layoutCanApply()) {
            pinDocumentScroll();       // 钉住滚动，杜绝自动画中画的触发条件（不滚动就直接返回）

            /* 播放器全屏期间：只留"钉住滚动"这一条，其它全部停手——
               不减B站的 autoPictureInPicture、不拉回 PiP/小窗、不往B站容器里写任何东西
               （面板/简介搬迁/右栏行内宽度/守卫自愈都跳过）。全屏时这些本来也看不见，
               退出全屏后下一次体检会把该补的一次补齐。 */
            if (!playerFs) {
                disableAutoPipFlag();  // 关掉浏览器自动画中画开关（走缓存，常态零查询）
                exitAutoMiniPip();     // 已经进了小窗就退出来（走缓存，常态零查询）

                // 换视频 / 节点被B站吞掉 / 还在等补全 → 全量重搬；否则每 5 秒兜底扫一次
                if (routeChanged || !panelIsHealthy() || tickCount % 5 === 0) {
                    // applyWidths 顺手校验行内宽度还在不在（B站重写 style 属性时补回来），代价是一次属性读
                    if (ensurePanel()) { syncPanelContents(); applyWidths(); }
                }
                guardNodesOnce();      // 标题/UP主面板/弹幕列表自愈（常态零查询）
            }
        }

        // 我们自己的节点/样式：被B站重渲染吞掉就补回来（全是引用比较，常态零查询）
        if (!playerFs) ensureOwnNodes();

        // 几何量（手柄位置 + 浮动滚动条）只在"尺寸/布局变了"之后重算一次，
        // 不再每秒读 getBoundingClientRect / scrollHeight 触发强制布局
        if (geoDirty) {
            geoDirty = false;
            if (layoutEnabled && !isDragging) positionHandle();
            if (getScrollbarMode() === 'overlay') updateOverlayScrollbar();
        }
        tickCount++;
    }

    /* ================= 初始化 ================= */

    function init() {
        ensureStaticStyle();
        buildLayoutStyle();
        applyWidths();
        registerSettingsMenu();
        lastRoutePath = window.location.pathname;
        lastRouteSearch = window.location.search;

        // 首屏结构性探测：B站前端 DOM 大改时主动提醒（只探一次，不刷屏）
        if (!document.querySelector(CONFIG.vdconSelector)) {
            console.warn('[BCTR] 未找到 #mirror-vdcon，B站页面结构可能已变更，脚本可能失效');
        }

        // 拖动窗口时 resize 事件密度远高于刷新率，合并到每帧一次
        const onResize = coalesceRaf(() => {
            geoDirty = true;
            if (!isDragging) positionHandle();
            updateOverlayScrollbar();
        });
        window.addEventListener('resize', onResize);

        // 容器尺寸变化（窗口缩放、左右栏拖宽、B站自己改布局）→ 打脏标记，
        // 由 rAF 合并后重算一次手柄位置与滚动条，不再每秒轮询几何量
        syncLayoutObservers();

        // 全屏状态镜像（html.bctr-player-fs）：CSS 靠它决定要不要清理播放器链路，
        // tick / 画中画守卫靠它决定要不要让路给B站
        installFullscreenMirror();
        installActionMenuGuards();
        installRouteObserver();

        // 记录真实用户操作时间，用于区分"手动开小窗"与"页面自动开小窗"。
        // ⚠ 不含 wheel：滚轮滚动不算 userActivation，若把它算进来会让 isUserInitiated()
        //   在滚过评论后长时间为 true，从而放行B站的自动画中画。
        ['pointerdown', 'mousedown', 'keydown', 'touchstart'].forEach(evt => {
            document.addEventListener(evt, markUserInput, true);
        });

        // 拖拽兜底：鼠标在窗口外松开 / 窗口失焦 / 指针被系统取消时，
        // document 上的 mouseup 不会触发，必须主动收尾，否则 userSelect:none 会一直残留。
        window.addEventListener('blur', () => { if (isDragging) onDragEnd(); });
        window.addEventListener('pointercancel', () => { if (isDragging) onDragEnd(); });

        // 单屏布局下 document 不该有任何滚动：一旦出现（评论区聚焦、浏览器滚动恢复等）立刻归零，
        // 否则播放器会被判定"离开视口"从而自动进入画中画，且用户无法滚回来。
        // 面板内部的滚动是合法的（它不会移动播放器），直接放过——
        // 翻评论时 scroll 事件每秒几十个，不能每个都去读一遍各容器的 scrollTop。
        window.addEventListener('scroll', (e) => {
            if (!layoutEnabled) return;
            const t = e.target;
            if (t && t.nodeType === 1) {
                const panel = getPanel();
                if (panel && (t === panel || panel.contains(t))) return;
            }
            pinDocumentScroll();
        }, true);
        document.addEventListener('enterpictureinpicture', () => {
            if (layoutEnabled && !isUserInitiated()) exitAutoMiniPip();
        }, true);

        // 滚轮调音量：必须挂捕获阶段 + passive:false，才能赶在播放器自己的滚轮处理之前
        // preventDefault 掉滚动（passive 监听里调 preventDefault 会被浏览器忽略并报错）。
        // 监听常驻，开关交给处理函数里的 wheelVolumeEnabled / layoutEnabled 判断，
        // 这样菜单里开关一次不需要重新挂/摘监听。
        window.addEventListener('wheel', onPlayerWheel, { capture: true, passive: false });

        // 视频元数据到位后戳一次播放器，让弹幕画布等内部组件重排；同时关掉浏览器自动画中画开关
        document.addEventListener('loadedmetadata', () => {
            nodeCache.videoEls = null;     // 新视频元素可能刚被换上，缓存作废
            nodeCache.videoEl = null;
            resetNodeMiss();               // 负缓存也作废：视频元素刚到位，别被"刚查过没有"挡住
            disableAutoPipFlag();
            updatePlayerLayout(true);
        }, true);

        // 回到前台立刻补一次体检（后台期间定时器与 rAF 都被浏览器节流）
        document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

        setInterval(tick, 1000);

        // 首屏兜底：DOM 就绪后再清一次滚动位置（浏览器可能恢复上次的滚动位置）
        const earlyPin = () => { disableAutoPipFlag(); pinDocumentScroll(); exitAutoMiniPip(); };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', earlyPin);
        } else {
            earlyPin();
        }
        setTimeout(earlyPin, 300);
        setTimeout(earlyPin, 1200);
        setTimeout(earlyPin, 3000);

        log('脚本初始化完成；布局:', layoutEnabled ? '客户端双栏' : 'B站原布局',
            '；右栏宽度', Math.round(rightPercent) + '%');
    }

    // document-start 只为提前接入评论组件定义；布局初始化仍等页面壳就绪。
    const start = () => {
        try {
            init();
        } catch (error) {
            console.error('[BCTR] 脚本初始化失败:', error);
        }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
})();