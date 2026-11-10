use anyhow::{Context, Result};
use auto_launch::{AutoLaunch, AutoLaunchBuilder};
use gpui::App;
use tray_icon::{
    Icon, MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent,
    menu::{Menu, MenuEvent, MenuItem},
};

pub const APP_ID: &str = "org.agent-space.adapter";
pub const APP_NAME: &str = "Agent 空间适配器";
const ICON_192: &[u8] = include_bytes!("../../../src/web/public/app-icon-192.png");

pub fn window_icon() -> Result<image::RgbaImage> {
    Ok(image::load_from_memory(ICON_192)?.into_rgba8())
}

#[cfg(target_os = "linux")]
pub fn register_launcher() -> Result<()> {
    use std::{fs, io::Write, os::unix::fs::PermissionsExt, path::Path};

    fn write_if_changed(path: &Path, bytes: &[u8]) -> Result<()> {
        if fs::read(path).is_ok_and(|old| old == bytes) {
            return Ok(());
        }
        let parent = path.parent().context("桌面入口目录无效")?;
        fs::create_dir_all(parent)?;
        let mut file = tempfile::NamedTempFile::new_in(parent)?;
        file.write_all(bytes)?;
        file.as_file()
            .set_permissions(fs::Permissions::from_mode(0o644))?;
        file.persist(path)?;
        Ok(())
    }

    let data = dirs::data_dir().context("无法定位桌面应用目录")?;
    let path = std::env::current_exe()?;
    let path = path.to_str().context("无法表示适配器路径")?;
    anyhow::ensure!(
        !path.contains('=') && !path.chars().any(char::is_control),
        "桌面入口路径无效"
    );
    let mut exec = String::new();
    for ch in path.chars() {
        match ch {
            '\\' => exec.push_str(r"\\\\"),
            '"' | '$' | '`' => {
                exec.push_str(r"\\");
                exec.push(ch);
            }
            '%' => exec.push_str("%%"),
            _ => exec.push(ch),
        }
    }
    write_if_changed(
        &data.join(format!("icons/hicolor/192x192/apps/{APP_ID}.png")),
        ICON_192,
    )?;
    let entry = format!(
        "[Desktop Entry]\nType=Application\nName={APP_NAME}\nName[en]=Agent Space Adapter\nExec=\"{exec}\"\nIcon={APP_ID}\nTerminal=false\nStartupWMClass={APP_ID}\nCategories=Utility;\n"
    );
    write_if_changed(
        &data.join(format!("applications/{APP_ID}.desktop")),
        entry.as_bytes(),
    )
}

pub fn startup() -> Result<AutoLaunch> {
    let path = std::env::current_exe()?;
    let mut setup = AutoLaunchBuilder::new();
    setup
        .set_app_name("agent-space-native")
        .set_app_path(path.to_str().context("无法表示适配器路径")?)
        .set_args(&["--background"]);
    #[cfg(windows)]
    setup.set_windows_enable_mode(auto_launch::WindowsEnableMode::CurrentUser);
    Ok(setup.build()?)
}

enum Event {
    Open,
    Quit,
}

pub fn install(cx: &mut App, mut open_window: impl FnMut(&mut App) + 'static) -> Result<()> {
    let image = image::load_from_memory(include_bytes!("../../../src/web/public/app-icon-32.png"))?
        .into_rgba8();
    let (width, height) = image.dimensions();
    let icon = Icon::from_rgba(image.into_raw(), width, height)?;
    let menu = Menu::new();
    let open = MenuItem::new("打开 Agent 空间适配器", true, None);
    let quit = MenuItem::new("退出适配器", true, None);
    menu.append(&open)?;
    menu.append(&quit)?;
    let icon = TrayIconBuilder::new()
        .with_id(APP_ID)
        .with_title(APP_NAME)
        .with_tooltip(APP_NAME)
        .with_menu(Box::new(menu))
        .with_icon(icon)
        .with_menu_on_left_click(false)
        .build()?;
    let (events, mut receive) = tokio::sync::mpsc::unbounded_channel();
    let click = events.clone();
    TrayIconEvent::set_event_handler(Some(move |event| {
        if matches!(
            event,
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
        ) {
            let _ = click.send(Event::Open);
        }
    }));
    let open = open.id().clone();
    let quit = quit.id().clone();
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        if event.id == open {
            let _ = events.send(Event::Open);
        }
        if event.id == quit {
            let _ = events.send(Event::Quit);
        }
    }));
    cx.spawn(async move |cx| {
        let _icon = icon;
        while let Some(event) = receive.recv().await {
            match event {
                Event::Open => cx.update(&mut open_window),
                Event::Quit => {
                    cx.update(|cx| cx.quit());
                    break;
                }
            }
        }
    })
    .detach();
    Ok(())
}
