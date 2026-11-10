use crate::{
    desktop_shell,
    gateway::{Phase, Snapshot},
    state::now,
};
use anyhow::{Result, anyhow};
use ely_core::{
    Assets,
    buttons::Button,
    data_display::QrCode,
    forms::{Input, PasswordInput, TextInput},
    navigation::NavItem,
    primitives::{FocusScope, Icon, IconName},
    theme::{Mode, Palette, Theme},
};
use gpui::{
    App, Bounds, Context, Div, FontWeight, IntoElement, ParentElement, QuitMode, Render, Styled,
    TitlebarOptions, Window, WindowBounds, WindowHandle, WindowOptions, div, prelude::*, px, rgb,
    size,
};
use std::{cell::RefCell, rc::Rc, time::Duration};
use tokio::sync::{mpsc, watch};

const INK: u32 = 0x1b2238;
const MUTED: u32 = 0x56617b;
const ACCENT: u32 = 0x414fc4;
const BORDER: u32 = 0xd7dcea;
const SURFACE: u32 = 0xf7f8fb;
const SIDEBAR: u32 = 0xeff2f9;

type Connect = Box<dyn FnMut(&str, String) -> Result<String>>;

struct Connection {
    origin: Option<String>,
    connect: Connect,
}

struct ConnectionFields {
    address: gpui::Entity<TextInput>,
    enrollment: gpui::Entity<TextInput>,
    error: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Page {
    Overview,
    Pair,
    Diagnostics,
    Settings,
}

impl Page {
    fn label(self) -> &'static str {
        match self {
            Self::Overview => "概览",
            Self::Pair => "连接手机",
            Self::Diagnostics => "诊断",
            Self::Settings => "设置",
        }
    }

    fn icon(self) -> IconName {
        match self {
            Self::Overview => IconName::House,
            Self::Pair => IconName::Smartphone,
            Self::Diagnostics => IconName::Activity,
            Self::Settings => IconName::Settings,
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Overview => "overview",
            Self::Pair => "pair",
            Self::Diagnostics => "diagnostics",
            Self::Settings => "settings",
        }
    }

    fn subtitle(self) -> &'static str {
        match self {
            Self::Overview => "查看这台电脑的远程连接状态。",
            Self::Pair => "首次使用时，扫码添加这台电脑。",
            Self::Diagnostics => "分别检查服务连接和本机 Agent 状态。",
            Self::Settings => "查看原生适配器使用的连接配置。",
        }
    }
}

struct AdapterWindow {
    page: Page,
    focus: gpui::FocusHandle,
    snapshot: Snapshot,
    pair: mpsc::Sender<()>,
    install: mpsc::Sender<()>,
    connection: Rc<RefCell<Connection>>,
    fields: Option<ConnectionFields>,
    startup: bool,
    startup_error: bool,
}

impl AdapterWindow {
    fn new(
        updates: watch::Receiver<Snapshot>,
        pair: mpsc::Sender<()>,
        install: mpsc::Sender<()>,
        connection: Rc<RefCell<Connection>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let snapshot = updates.borrow().clone();
        cx.spawn(async move |view, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(500))
                    .await;
                let snapshot = updates.borrow().clone();
                if view
                    .update(cx, |view, cx| {
                        if view.snapshot != snapshot || snapshot.pairing.is_some() {
                            view.snapshot = snapshot;
                            cx.notify();
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        let fields = connection
            .borrow()
            .origin
            .is_none()
            .then(|| ConnectionFields {
                address: cx.new(|cx| {
                    TextInput::new(window, cx)
                        .label("服务地址")
                        .placeholder("https://agent.example.com")
                }),
                enrollment: cx.new(|cx| {
                    TextInput::new(window, cx)
                        .label("接入密钥")
                        .placeholder("已登记的电脑可留空")
                        .masked()
                }),
                error: None,
            });
        Self {
            page: Page::Overview,
            focus: cx.focus_handle(),
            snapshot,
            pair,
            install,
            connection,
            fields,
            startup: desktop_shell::startup()
                .and_then(|entry| Ok(entry.is_enabled()?))
                .unwrap_or(false),
            startup_error: false,
        }
    }

    fn navigate(
        &self,
        page: Page,
        id: &'static str,
        label: &'static str,
        cx: &Context<Self>,
    ) -> Button {
        let view = cx.weak_entity();
        Button::new(id, label).on_click(move |_, _, cx| {
            let _ = view.update(cx, |view, cx| {
                view.page = page;
                cx.notify();
            });
        })
    }

    fn service_status(&self) -> (&'static str, u32) {
        match self.snapshot.phase {
            Phase::Setup => ("待配置", 0x74809a),
            Phase::Connecting => ("连接中", 0x97701a),
            Phase::Online => ("已连接", 0x1b794e),
            Phase::Unavailable => ("暂不可用，等待重连", 0x9b5218),
        }
    }

    fn service_indicator(&self) -> Div {
        let (label, color) = self.service_status();
        div()
            .flex()
            .items_center()
            .gap_2()
            .text_color(rgb(color))
            .child(div().size(px(8.)).rounded_full().bg(rgb(color)))
            .child(label)
    }

    fn agent_status(&self) -> String {
        if !self.snapshot.agents.is_empty() {
            self.snapshot
                .agents
                .iter()
                .map(|agent| {
                    format!(
                        "{} {}",
                        agent.name,
                        if agent.connected {
                            "已连接"
                        } else {
                            "待接入"
                        }
                    )
                })
                .collect::<Vec<_>>()
                .join(" · ")
        } else if self.snapshot.history {
            "Codex 已配置".into()
        } else {
            "待接入".into()
        }
    }

    fn overview(&self, cx: &Context<Self>) -> Div {
        let (heading, help) = match self.snapshot.phase {
            Phase::Setup => ("等待配置服务", "配置服务地址后，手机就能找到这台电脑。"),
            Phase::Online => ("适配器已在线", "手机可以与这台电脑建立加密连接。"),
            _ => ("正在连接服务", "适配器会在网络恢复后自动重连。"),
        };
        let target = if self.connection.borrow().origin.is_some() {
            Page::Pair
        } else {
            Page::Settings
        };
        let (label, icon) = if target == Page::Pair {
            ("前往配对", IconName::Smartphone)
        } else {
            ("查看设置", IconName::Settings)
        };
        div()
            .flex()
            .flex_col()
            .gap_4()
            .child(
                card()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_4()
                            .pb_3()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .size(px(52.))
                                    .rounded_lg()
                                    .bg(rgb(0xe9ecfe))
                                    .text_color(rgb(ACCENT))
                                    .child(Icon::new(IconName::Link)),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap_1()
                                    .child(section_title(heading))
                                    .child(note(help)),
                            ),
                    )
                    .child(row("服务连接", self.service_indicator()))
                    .child(row("本机 Agent", note(self.agent_status()))),
            )
            .child(
                card()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap_4()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(section_title("连接手机"))
                            .child(note("生成一次性二维码，添加这台电脑。")),
                    )
                    .child(
                        self.navigate(target, "next-step", label, cx)
                            .primary()
                            .icon(icon),
                    ),
            )
    }

    fn pairing(&self) -> Div {
        let active = self
            .snapshot
            .pairing
            .as_ref()
            .filter(|code| code.expires_at > now());
        let pair = self.pair.clone();
        let ready = self.snapshot.phase == Phase::Online;
        let detail = if !ready {
            "中继连接成功后可生成二维码。".to_owned()
        } else if let Some(code) = active {
            let seconds = (code.expires_at - now()).max(0) / 1000;
            format!("剩余 {}:{:02} · 仅限一次使用", seconds / 60, seconds % 60)
        } else {
            "二维码 5 分钟内有效，用过即失效。".to_owned()
        };
        let qr = if let Some(code) = active.filter(|_| ready) {
            QrCode::new(&code.link).ok()
        } else {
            None
        };
        card()
            .flex_row()
            .items_center()
            .gap_6()
            .min_h(px(248.))
            .child(
                div()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(section_title("用手机扫描二维码"))
                    .child(note("用手机相机扫一扫，打开后点击「连接电脑」。"))
                    .child(
                        Button::new(
                            "generate",
                            if active.is_some() {
                                "重新生成"
                            } else {
                                "生成配对二维码"
                            },
                        )
                        .primary()
                        .icon(IconName::RefreshCw)
                        .disabled(!ready)
                        .on_click(move |_, _, _| {
                            let _ = pair.try_send(());
                        }),
                    )
                    .child(note(detail)),
            )
            .child(
                div()
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(182.))
                    .border_1()
                    .border_color(rgb(BORDER))
                    .rounded_lg()
                    .when_some(qr, |tile, qr| tile.child(qr))
                    .when(!ready || active.is_none(), |tile| {
                        tile.child(note("等待生成"))
                    }),
            )
    }

    fn diagnostics(&self) -> Div {
        let (state, _) = self.service_status();
        let summary = format!(
            "Agent 空间原生适配器 {} · {}\n服务连接：{}\n本机 Agent：{}\n传输：Noise / WebSocket",
            env!("CARGO_PKG_VERSION"),
            platform_name(),
            state,
            self.agent_status(),
        );
        card()
            .child(section_title("连接检查"))
            .child(row("服务连接", self.service_indicator()))
            .child(row("本机 Agent", note(self.agent_status())))
            .child(row("设备通道", note("Noise 加密 · WebSocket")))
            .child(
                div().pt_3().child(
                    Button::new("copy-diagnostics", "复制诊断")
                        .icon(IconName::Copy)
                        .on_click(move |_, _, cx| {
                            cx.write_to_clipboard(gpui::ClipboardItem::new_string(summary.clone()))
                        }),
                ),
            )
    }

    fn settings(&self, cx: &Context<Self>) -> Div {
        let panel = card().child(section_title("连接配置"));
        let Some(fields) = &self.fields else {
            let view = cx.weak_entity();
            let install = self.install.clone();
            return div()
                .flex()
                .flex_col()
                .gap_4()
                .child(
                    panel
                        .child(row(
                            "服务地址",
                            note(self.connection.borrow().origin.clone().unwrap_or_default()),
                        ))
                        .child(note("更改服务地址可在退出后以 --configure 启动。")),
                )
                .child(
                    card()
                        .child(section_title("启动与运行"))
                        .child(row(
                            "登录时启动",
                            Button::new(
                                "auto-start",
                                if self.startup {
                                    "关闭自启动"
                                } else {
                                    "启用自启动"
                                },
                            )
                            .disabled(!self.startup && self.snapshot.phase != Phase::Online)
                            .on_click(move |_, _, cx| {
                                let _ = view.update(cx, |view, cx| {
                                    let result = desktop_shell::startup().and_then(|entry| {
                                        if view.startup {
                                            entry.disable()?;
                                        } else {
                                            entry.enable()?;
                                        }
                                        Ok(())
                                    });
                                    view.startup_error = result.is_err();
                                    if result.is_ok() {
                                        view.startup = !view.startup;
                                    }
                                    cx.notify();
                                });
                            }),
                        ))
                        .when(self.startup_error, |card| {
                            card.child(note("无法修改自启动，请检查系统设置。"))
                        })
                        .when(!self.snapshot.update.is_empty(), |card| {
                            card.child(row("自动更新", note(self.snapshot.update.clone())))
                        })
                        .when(self.snapshot.manual_update, |card| {
                            card.child(Button::new("install-update", "安装已下载更新").on_click(
                                move |_, _, _| {
                                    let _ = install.try_send(());
                                },
                            ))
                        })
                        .child(div().flex().child(
                            Button::new("quit", "退出适配器").on_click(|_, _, cx| cx.quit()),
                        )),
                );
        };
        let view = cx.weak_entity();
        panel
            .gap_3()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(note("服务地址"))
                    .child(Input::new(&fields.address)),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(note("接入密钥"))
                    .child(PasswordInput::new(&fields.enrollment)),
            )
            .when_some(fields.error.clone(), |panel, error| {
                panel.child(
                    div()
                        .text_color(rgb(0xb13938))
                        .text_size(px(14.))
                        .child(error),
                )
            })
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_3()
                    .child(Button::new("connect", "连接服务").primary().on_click(
                        move |_, _, cx| {
                            let _ = view.update(cx, |view, cx| {
                                let Some(fields) = &mut view.fields else {
                                    return;
                                };
                                let origin = fields.address.read(cx).text().trim().to_owned();
                                let enrollment =
                                    fields.enrollment.read(cx).text().trim().to_owned();
                                let mut connection = view.connection.borrow_mut();
                                match (connection.connect)(&origin, enrollment) {
                                    Ok(origin) => {
                                        fields
                                            .enrollment
                                            .update(cx, |input, cx| input.set_text("", cx));
                                        view.fields = None;
                                        connection.origin = Some(origin);
                                        view.page = Page::Overview;
                                    }
                                    Err(error) => fields.error = Some(error.to_string()),
                                }
                                cx.notify();
                            });
                        },
                    ))
                    .child(note("记住服务地址，接入密钥只在本次启动使用。")),
            )
    }
}

impl Render for AdapterWindow {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut sidebar = div()
            .flex()
            .flex_col()
            .w(px(184.))
            .flex_none()
            .px_4()
            .py_6()
            .gap_3()
            .bg(rgb(SIDEBAR))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_3()
                    .pb_4()
                    .child(
                        div()
                            .text_color(rgb(ACCENT))
                            .child(Icon::new(IconName::Network)),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .child(div().font_weight(FontWeight::BOLD).child("Agent 空间"))
                            .child(note("电脑适配器")),
                    ),
            );
        for page in [
            Page::Overview,
            Page::Pair,
            Page::Diagnostics,
            Page::Settings,
        ] {
            let view = cx.weak_entity();
            sidebar = sidebar.child(
                NavItem::new(page.id(), page.icon(), page.label())
                    .active(self.page == page)
                    .on_click(move |_, cx| {
                        let _ = view.update(cx, |view, cx| {
                            view.page = page;
                            cx.notify();
                        });
                    }),
            );
        }
        sidebar = sidebar.child(div().mt_auto().child(note(format!(
            "{} · v{}",
            platform_name(),
            env!("CARGO_PKG_VERSION"),
        ))));
        let body = match self.page {
            Page::Overview => self.overview(cx),
            Page::Pair => self.pairing(),
            Page::Diagnostics => self.diagnostics(),
            Page::Settings => self.settings(cx),
        };
        let origin = self.connection.borrow().origin.clone();
        FocusScope::new(&self.focus)
            .root()
            .size_full()
            .flex()
            .bg(rgb(SURFACE))
            .text_color(rgb(INK))
            .child(sidebar)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .p_8()
                    .flex()
                    .flex_col()
                    .gap_6()
                    .child(
                        div()
                            .flex()
                            .justify_between()
                            .items_start()
                            .gap_4()
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap_2()
                                    .child(
                                        div()
                                            .text_size(px(28.))
                                            .font_weight(FontWeight::BOLD)
                                            .child(self.page.label()),
                                    )
                                    .child(note(self.page.subtitle())),
                            )
                            .when(self.page == Page::Overview, |header| {
                                header.child(
                                    Button::new("open-workbench", "打开工作台")
                                        .icon(IconName::ExternalLink)
                                        .disabled(origin.is_none())
                                        .on_click(move |_, _, cx| {
                                            if let Some(origin) = &origin {
                                                cx.open_url(origin);
                                            }
                                        }),
                                )
                            }),
                    )
                    .child(body),
            )
    }
}

fn section_title(label: &'static str) -> Div {
    div()
        .text_size(px(19.))
        .font_weight(FontWeight::BOLD)
        .child(label)
}

fn note(text: impl Into<gpui::SharedString>) -> Div {
    div()
        .text_size(px(14.))
        .text_color(rgb(MUTED))
        .child(text.into())
}

fn card() -> Div {
    div()
        .flex()
        .flex_col()
        .gap_2()
        .p_5()
        .bg(rgb(0xffffff))
        .border_1()
        .border_color(rgb(BORDER))
        .rounded_lg()
}

fn row(label: &'static str, value: impl IntoElement) -> Div {
    div()
        .border_t_1()
        .border_color(rgb(BORDER))
        .pt_3()
        .pb_1()
        .flex()
        .items_center()
        .justify_between()
        .gap_4()
        .child(div().font_weight(FontWeight::MEDIUM).child(label))
        .child(value)
}

fn platform_name() -> &'static str {
    match std::env::consts::OS {
        "windows" => "Windows",
        "macos" => "macOS",
        _ => "Linux",
    }
}

fn open_window(
    window: &mut Option<WindowHandle<AdapterWindow>>,
    updates: &watch::Receiver<Snapshot>,
    pair: &mpsc::Sender<()>,
    install: &mpsc::Sender<()>,
    connection: &Rc<RefCell<Connection>>,
    cx: &mut App,
) -> Result<()> {
    if let Some(handle) = window
        && handle
            .update(cx, |_, window, _| window.activate_window())
            .is_ok()
    {
        return Ok(());
    }
    let options = WindowOptions {
        titlebar: Some(TitlebarOptions {
            title: Some(desktop_shell::APP_NAME.into()),
            ..Default::default()
        }),
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
            None,
            size(px(830.), px(552.)),
            cx,
        ))),
        window_min_size: Some(size(px(700.), px(494.))),
        app_id: Some(desktop_shell::APP_ID.into()),
        icon: Some(std::sync::Arc::new(desktop_shell::window_icon()?)),
        ..Default::default()
    };
    *window = Some(cx.open_window(options, |window, cx| {
        cx.new(|cx| {
            AdapterWindow::new(
                updates.clone(),
                pair.clone(),
                install.clone(),
                connection.clone(),
                window,
                cx,
            )
        })
    })?);
    cx.activate(true);
    Ok(())
}

pub fn run(
    updates: watch::Receiver<Snapshot>,
    pair: mpsc::Sender<()>,
    install: mpsc::Sender<()>,
    origin: Option<String>,
    connect: Connect,
    background: bool,
) -> Result<()> {
    let error = Rc::new(RefCell::new(None));
    let failure = error.clone();
    gpui_platform::application()
        .with_assets(Assets)
        .run(move |cx: &mut App| {
            let result = (|| -> Result<()> {
                let mut shutdown = updates.clone();
                cx.spawn(async move |cx| {
                    loop {
                        if shutdown.borrow_and_update().exit_for_update {
                            cx.update(|cx| cx.quit());
                            break;
                        }
                        if shutdown.changed().await.is_err() {
                            break;
                        }
                    }
                })
                .detach();
                cx.set_app_identity(desktop_shell::APP_ID, desktop_shell::APP_NAME);
                #[cfg(target_os = "linux")]
                if let Err(error) = desktop_shell::register_launcher() {
                    eprintln!("无法注册桌面入口：{error}");
                }
                ely_core::init(cx)?;
                let mut palette = Palette::light(false);
                palette.accent = rgb(ACCENT).into();
                palette.accent_hover = rgb(0x3543af).into();
                palette.hover = rgb(0xe1e5fa).into();
                palette.focus = rgb(ACCENT).into();
                Theme::set_palette(Mode::Light, Some(palette), cx);
                Theme::set_mode_now(Mode::Light, cx);
                let configured = origin.is_some();
                let connection = Rc::new(RefCell::new(Connection { origin, connect }));
                let window = Rc::new(RefCell::new(None));
                let show = {
                    let window = window.clone();
                    let updates = updates.clone();
                    let pair = pair.clone();
                    let install = install.clone();
                    let connection = connection.clone();
                    move |cx: &mut App| {
                        if let Err(error) = open_window(
                            &mut window.borrow_mut(),
                            &updates,
                            &pair,
                            &install,
                            &connection,
                            cx,
                        ) {
                            eprintln!("无法从托盘打开适配器：{error}");
                        }
                    }
                };
                let tray = desktop_shell::install(cx, show);
                let has_tray = match tray {
                    Ok(()) => {
                        cx.set_quit_mode(QuitMode::Explicit);
                        true
                    }
                    Err(error) => {
                        eprintln!("无法创建系统托盘图标：{error}");
                        cx.set_quit_mode(QuitMode::LastWindowClosed);
                        false
                    }
                };
                if !background || !configured || !has_tray {
                    open_window(
                        &mut window.borrow_mut(),
                        &updates,
                        &pair,
                        &install,
                        &connection,
                        cx,
                    )?;
                }
                Ok(())
            })();
            if let Err(error) = result {
                *failure.borrow_mut() = Some(error);
                cx.quit();
            }
        });
    match error.borrow_mut().take() {
        Some(error) => Err(anyhow!("无法打开 Ely 界面：{error:#}")),
        None => Ok(()),
    }
}
