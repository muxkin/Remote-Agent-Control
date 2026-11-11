use crate::management::TrayEvent;
use anyhow::{Context, Result};
use auto_launch::{AutoLaunch, AutoLaunchBuilder};
use tray_icon::{
    Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent,
    menu::{Menu, MenuEvent, MenuItem},
};

pub const APP_ID: &str = "org.agent-space.adapter";
pub const APP_NAME: &str = "Agent 空间适配器";
const ICON_32: &[u8] = include_bytes!("../../../src/web/public/app-icon-32.png");
#[cfg(target_os = "linux")]
const ICON_192: &[u8] = include_bytes!("../../../src/web/public/app-icon-192.png");

#[cfg(target_os = "linux")]
fn launcher_icon() -> Result<image::RgbaImage> {
    Ok(image::load_from_memory(ICON_192)?.into_rgba8())
}

#[cfg(target_os = "linux")]
pub fn register_launcher() -> Result<()> {
    use std::{fs, io::Write, os::unix::fs::PermissionsExt, path::Path};

    fn write_if_changed(path: &Path, bytes: &[u8]) -> Result<bool> {
        if fs::read(path).is_ok_and(|old| old == bytes) {
            return Ok(false);
        }
        let parent = path.parent().context("桌面入口目录无效")?;
        fs::create_dir_all(parent)?;
        let mut file = tempfile::NamedTempFile::new_in(parent)?;
        file.write_all(bytes)?;
        file.as_file()
            .set_permissions(fs::Permissions::from_mode(0o644))?;
        file.persist(path)?;
        Ok(true)
    }

    let data = dirs::data_dir().context("无法定位桌面应用目录")?;
    let path = std::env::current_exe()?;
    if path == Path::new("/usr/bin/agent-space-native") {
        // The system package provides its own launcher and icon.
        return Ok(());
    }
    let path = path.to_str().context("无法表示适配器路径")?;
    let exec = desktop_exec(path)?;
    use image::ImageEncoder;
    let icon_48 = image::imageops::resize(
        &launcher_icon()?,
        48,
        48,
        image::imageops::FilterType::Lanczos3,
    );
    let mut png_48 = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png_48).write_image(
        icon_48.as_raw(),
        48,
        48,
        image::ExtendedColorType::Rgba8,
    )?;
    let theme = data.join("icons/hicolor");
    let mut icons_changed = false;
    for (size, png) in [(32, ICON_32), (48, png_48.as_slice()), (192, ICON_192)] {
        icons_changed |=
            write_if_changed(&theme.join(format!("{size}x{size}/apps/{APP_ID}.png")), png)?;
    }
    if icons_changed {
        fs::File::open(&theme)?.set_modified(std::time::SystemTime::now())?;
    }
    let entry = format!(
        "[Desktop Entry]\nType=Application\nName={APP_NAME}\nName[en]=Agent Space Adapter\nExec={exec}\nIcon={APP_ID}\nTerminal=false\nStartupWMClass={APP_ID}\nCategories=Utility;\n"
    );
    let entry_changed = write_if_changed(
        &data.join(format!("applications/{APP_ID}.desktop")),
        entry.as_bytes(),
    )?;
    if (icons_changed || entry_changed)
        && std::env::var("XDG_CURRENT_DESKTOP")
            .is_ok_and(|desktop| desktop.split(':').any(|name| name == "KDE"))
    {
        // Refresh both Plasma's named-icon and desktop-entry caches on installation.
        if let Ok(bus) = zbus::blocking::Connection::session() {
            let _ = bus.emit_signal(
                None::<&str>,
                "/KIconLoader",
                "org.kde.KIconLoader",
                "iconChanged",
                &(0_i32,), // KIconLoader::Desktop
            );
        }
        let _ = std::process::Command::new("kbuildsycoca6")
            .arg("--noincremental")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn desktop_exec(path: &str) -> Result<String> {
    anyhow::ensure!(
        !path.contains('=') && !path.chars().any(char::is_control),
        "桌面入口路径无效"
    );
    let mut exec = String::from("\"");
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
    exec.push('"');
    Ok(exec)
}

pub fn startup() -> Result<AutoLaunch> {
    let path = std::env::current_exe()?;
    let path = path.to_str().context("无法表示适配器路径")?;
    #[cfg(target_os = "linux")]
    let quoted_path = desktop_exec(path)?;
    // auto-launch writes the Windows Run value as a command line.
    #[cfg(windows)]
    let quoted_path = format!("\"{path}\"");
    #[cfg(any(target_os = "linux", windows))]
    let path = &quoted_path;
    let mut setup = AutoLaunchBuilder::new();
    setup
        .set_app_name("agent-space-native")
        .set_app_path(path)
        .set_args(&["--background"]);
    #[cfg(windows)]
    setup.set_windows_enable_mode(auto_launch::WindowsEnableMode::CurrentUser);
    Ok(setup.build()?)
}

pub fn install(events: tokio::sync::mpsc::UnboundedSender<TrayEvent>) -> Result<TrayIcon> {
    let image = image::load_from_memory(ICON_32)?.into_rgba8();
    let (width, height) = image.dimensions();
    let icon = Icon::from_rgba(image.into_raw(), width, height)?;
    let menu = Menu::new();
    let open = MenuItem::new("打开设置", true, None);
    let check = MenuItem::new("检查更新", true, None);
    let quit = MenuItem::new("退出适配器", true, None);
    menu.append(&open)?;
    menu.append(&check)?;
    menu.append(&quit)?;
    let tray = TrayIconBuilder::new()
        .with_id(APP_ID)
        .with_title(APP_NAME)
        .with_tooltip(APP_NAME)
        .with_menu(Box::new(menu))
        .with_icon(icon)
        .with_menu_on_left_click(false)
        .build()?;
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
            let _ = click.send(TrayEvent::Open);
        }
    }));
    let (open, check, quit) = (open.id().clone(), check.id().clone(), quit.id().clone());
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        let action = if event.id == open {
            TrayEvent::Open
        } else if event.id == check {
            TrayEvent::CheckUpdate
        } else if event.id == quit {
            TrayEvent::Quit
        } else {
            return;
        };
        let _ = events.send(action);
    }));
    Ok(tray)
}

#[cfg(target_os = "macos")]
mod app_delegate {
    use super::TrayEvent;
    use objc2::{
        DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained,
        runtime::ProtocolObject,
    };
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy, NSApplicationDelegate};
    use objc2_foundation::{NSObject, NSObjectProtocol};
    use tokio::sync::mpsc::UnboundedSender;

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = UnboundedSender<TrayEvent>]
        pub(super) struct AgentSpaceTrayDelegate;

        unsafe impl NSObjectProtocol for AgentSpaceTrayDelegate {}
        unsafe impl NSApplicationDelegate for AgentSpaceTrayDelegate {
            #[unsafe(method(applicationShouldHandleReopen:hasVisibleWindows:))]
            fn reopen(&self, _: &NSApplication, _: bool) -> bool {
                let _ = self.ivars().send(TrayEvent::Open);
                false
            }
        }
    );

    pub(super) fn register(events: UnboundedSender<TrayEvent>) -> Retained<AgentSpaceTrayDelegate> {
        let marker = MainThreadMarker::new().expect("AppKit runs on the main thread");
        let app = NSApplication::sharedApplication(marker);
        app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
        let delegate = AgentSpaceTrayDelegate::alloc(marker).set_ivars(events);
        let delegate: Retained<AgentSpaceTrayDelegate> =
            unsafe { msg_send![super(delegate), init] };
        app.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        delegate
    }
}

#[cfg(target_os = "macos")]
pub fn prepare(events: tokio::sync::mpsc::UnboundedSender<TrayEvent>) -> impl Sized {
    app_delegate::register(events)
}

#[cfg(not(target_os = "macos"))]
pub fn prepare(_events: tokio::sync::mpsc::UnboundedSender<TrayEvent>) {}

#[cfg(windows)]
pub fn drive<T: Send + 'static>(
    runtime: &tokio::runtime::Runtime,
    future: impl Future<Output = T> + Send + 'static,
) -> Result<T> {
    use windows_sys::Win32::{
        System::Threading::GetCurrentThreadId,
        UI::WindowsAndMessaging::{
            DispatchMessageW, GetMessageW, MSG, PM_NOREMOVE, PeekMessageW, PostThreadMessageW,
            TranslateMessage, WM_QUIT,
        },
    };
    let mut message = MSG::default();
    let thread = unsafe {
        // PeekMessage creates the thread's queue before the worker can post to it.
        PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
        GetCurrentThreadId()
    };
    let task = runtime.spawn(async move {
        let result = future.await;
        unsafe { PostThreadMessageW(thread, WM_QUIT, 0, 0) };
        result
    });
    loop {
        let status = unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) };
        anyhow::ensure!(status >= 0, "无法读取托盘消息");
        if status == 0 {
            break;
        }
        unsafe {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    Ok(runtime.block_on(task)?)
}

#[cfg(target_os = "macos")]
pub fn drive<T: Send + 'static>(
    runtime: &tokio::runtime::Runtime,
    future: impl Future<Output = T> + Send + 'static,
) -> Result<T> {
    use dispatch2::DispatchQueue;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSEvent, NSEventModifierFlags, NSEventType};

    let marker = MainThreadMarker::new().expect("AppKit runs on the main thread");
    let app = NSApplication::sharedApplication(marker);
    let task = runtime.spawn(async move {
        let result = future.await;
        DispatchQueue::main().exec_async(|| {
            let marker = MainThreadMarker::new().expect("main queue runs on the main thread");
            let app = NSApplication::sharedApplication(marker);
            app.stop(None);
            // AppKit finishes stopping after its event loop handles the next event.
            if let Some(event) = NSEvent::otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2(
                NSEventType::ApplicationDefined,
                Default::default(),
                NSEventModifierFlags::empty(),
                0.0,
                0,
                None,
                0,
                0,
                0,
            ) {
                app.postEvent_atStart(&event, false);
            }
        });
        result
    });
    app.run();
    Ok(runtime.block_on(task)?)
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn drive<T>(runtime: &tokio::runtime::Runtime, future: impl Future<Output = T>) -> Result<T> {
    Ok(runtime.block_on(future))
}
