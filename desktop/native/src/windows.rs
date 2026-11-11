use anyhow::{Result, ensure};
use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io,
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
    ptr::null_mut,
};
use windows_sys::Win32::{
    Foundation::{GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE, LocalFree},
    Globalization::{CSTR_EQUAL, CompareStringOrdinal},
    Security::{
        ACCESS_ALLOWED_ACE, ACE_HEADER,
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            GetSecurityInfo, SDDL_REVISION_1, SE_FILE_OBJECT, SetSecurityInfo,
        },
        DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetTokenInformation, IsWellKnownSid,
        OWNER_SECURITY_INFORMATION, PSID, SECURITY_ATTRIBUTES, TOKEN_INFORMATION_CLASS,
        TOKEN_OWNER, TOKEN_QUERY, TOKEN_USER, TokenOwner, TokenUser, WinBuiltinAdministratorsSid,
        WinLocalSystemSid,
    },
    Storage::FileSystem::{
        CREATE_NEW, CreateDirectoryW, CreateFileW, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, GetFileInformationByHandle,
        OPEN_ALWAYS, OPEN_EXISTING, READ_CONTROL, WRITE_OWNER,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

const SHARE: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain([0]).collect()
}

fn ok(result: i32) -> io::Result<()> {
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

struct Local(*mut std::ffi::c_void);
impl Drop for Local {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}

struct User(Vec<usize>);
impl User {
    fn read(process: HANDLE) -> Result<Self> {
        Ok(Self(token_info(
            process,
            TokenUser,
            std::mem::size_of::<TOKEN_USER>(),
        )?))
    }

    fn current() -> Result<Self> {
        Self::read(unsafe { GetCurrentProcess() })
    }

    fn sid(&self) -> PSID {
        unsafe { (*self.0.as_ptr().cast::<TOKEN_USER>()).User.Sid }
    }

    fn text(&self) -> Result<String> {
        let mut value = null_mut();
        unsafe {
            ok(ConvertSidToStringSidW(self.sid(), &mut value))?;
        }
        let _allocation = Local(value.cast());
        let len = (0..256)
            .position(|offset| unsafe { *value.add(offset) == 0 })
            .ok_or_else(|| anyhow::anyhow!("Windows 用户标识过长"))?;
        Ok(String::from_utf16(unsafe {
            std::slice::from_raw_parts(value, len)
        })?)
    }
}

fn token_info(
    process: HANDLE,
    class: TOKEN_INFORMATION_CLASS,
    min_size: usize,
) -> Result<Vec<usize>> {
    let mut token = null_mut();
    unsafe {
        ok(OpenProcessToken(process, TOKEN_QUERY, &mut token))?;
    }
    let _token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut needed = 0;
    unsafe {
        GetTokenInformation(token, class, null_mut(), 0, &mut needed);
    }
    ensure!(
        needed as usize >= min_size && needed <= 65536,
        "无法读取 Windows 用户身份"
    );
    let mut buffer = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
    unsafe {
        ok(GetTokenInformation(
            token,
            class,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        ))?;
    }
    Ok(buffer)
}

fn descriptor(user: &User, directory: bool) -> Result<Local> {
    let owner = user.text()?;
    let inherit = if directory { "OICI" } else { "" };
    let value: Vec<_> = format!("O:{owner}D:P(A;{inherit};FA;;;{owner})(A;{inherit};FA;;;SY)")
        .encode_utf16()
        .chain([0])
        .collect();
    let mut descriptor = Local(null_mut());
    unsafe {
        ok(ConvertStringSecurityDescriptorToSecurityDescriptorW(
            value.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor.0,
            null_mut(),
        ))?;
    }
    Ok(descriptor)
}

fn attributes(descriptor: &mut Local) -> SECURITY_ATTRIBUTES {
    SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    }
}

pub fn private_directory(path: &Path) -> Result<()> {
    let user = User::current()?;
    if !path.exists() {
        if let Some(parent) = path.parent().filter(|value| !value.as_os_str().is_empty()) {
            fs::create_dir_all(parent)?;
        }
        let mut security = descriptor(&user, true)?;
        let created = unsafe { CreateDirectoryW(wide(path).as_ptr(), &attributes(&mut security)) };
        if created == 0 {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::AlreadyExists {
                return Err(error.into());
            }
        }
    }
    let file = OpenOptions::new()
        .access_mode(READ_CONTROL)
        .share_mode(SHARE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?;
    verify(file.as_raw_handle(), &user, true, OwnerPolicy::Current)
}

pub fn private_file(path: &Path, create: bool) -> Result<File> {
    let disposition = if create { OPEN_ALWAYS } else { OPEN_EXISTING };
    open_private_file(path, disposition, OwnerPolicy::Current)
}

pub(crate) fn create_private_file(path: &Path) -> Result<File> {
    open_private_file(path, CREATE_NEW, OwnerPolicy::Current)
}

pub(crate) fn legacy_private_file(path: &Path) -> Result<File> {
    open_private_file(path, OPEN_EXISTING, OwnerPolicy::LegacyRead)
}

fn open_private_file(path: &Path, disposition: u32, owner: OwnerPolicy) -> Result<File> {
    let user = User::current()?;
    let mut security = descriptor(&user, false)?;
    let flags = if disposition != OPEN_EXISTING {
        GENERIC_READ | GENERIC_WRITE
    } else {
        GENERIC_READ
    };
    let handle = unsafe {
        CreateFileW(
            wide(path).as_ptr(),
            flags | READ_CONTROL,
            SHARE,
            &attributes(&mut security),
            disposition,
            FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error().into());
    }
    let file = unsafe { File::from_raw_handle(handle) };
    verify(handle, &user, false, owner)?;
    Ok(file)
}

pub(crate) fn private_sqlite_sidecar(path: &Path) -> Result<()> {
    if private_file(path, false).is_ok() {
        return Ok(());
    }
    let user = User::current()?;
    let file = OpenOptions::new()
        .access_mode(READ_CONTROL | WRITE_OWNER)
        .share_mode(SHARE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    verify(
        file.as_raw_handle(),
        &user,
        false,
        OwnerPolicy::SqliteSidecar,
    )
}

enum OwnerPolicy {
    Current,
    LegacyRead,
    SqliteSidecar,
}

fn verify(handle: HANDLE, user: &User, directory: bool, policy: OwnerPolicy) -> Result<()> {
    let mut info = unsafe { std::mem::zeroed() };
    unsafe {
        ok(GetFileInformationByHandle(handle, &mut info))?;
    }
    ensure!(
        info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0
            && (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) == directory,
        "Windows 状态路径类型不安全"
    );
    let mut owner = null_mut();
    let mut dacl = null_mut();
    let mut security = Local(null_mut());
    let error = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut security.0,
        )
    };
    if error != 0 {
        return Err(io::Error::from_raw_os_error(error as i32).into());
    }
    ensure!(
        !owner.is_null() && !dacl.is_null(),
        "Windows 状态文件缺少属主或 ACL"
    );
    let default_admin_owner = unsafe { EqualSid(owner, user.sid()) } == 0;
    if default_admin_owner {
        ensure!(
            !matches!(policy, OwnerPolicy::Current)
                && unsafe { IsWellKnownSid(owner, WinBuiltinAdministratorsSid) } != 0,
            "Windows 状态文件必须属于当前用户"
        );
        let token = token_info(
            unsafe { GetCurrentProcess() },
            TokenOwner,
            std::mem::size_of::<TOKEN_OWNER>(),
        )?;
        let default_owner = unsafe { (*token.as_ptr().cast::<TOKEN_OWNER>()).Owner };
        ensure!(
            !default_owner.is_null() && unsafe { EqualSid(owner, default_owner) } != 0,
            "Windows 状态文件的默认属主无效"
        );
    }
    let mut own = false;
    let mut system = false;
    for i in 0..unsafe { (*dacl).AceCount as u32 } {
        let mut ace = null_mut();
        unsafe {
            ok(GetAce(dacl, i, &mut ace))?;
        }
        let header = unsafe { &*ace.cast::<ACE_HEADER>() };
        ensure!(
            header.AceType == 0
                && header.AceSize as usize >= std::mem::size_of::<ACCESS_ALLOWED_ACE>(),
            "Windows 状态 ACL 包含不受支持的规则"
        );
        let sid = unsafe { &mut (*ace.cast::<ACCESS_ALLOWED_ACE>()).SidStart as *mut u32 }.cast();
        if unsafe { EqualSid(sid, user.sid()) } != 0 {
            own = true;
        } else if unsafe { IsWellKnownSid(sid, WinLocalSystemSid) } != 0 {
            system = true;
        } else {
            anyhow::bail!("Windows 状态 ACL 必须仅允许当前用户和 SYSTEM");
        }
    }
    ensure!(own && system, "Windows 状态 ACL 缺少必要权限");
    if default_admin_owner && matches!(policy, OwnerPolicy::SqliteSidecar) {
        let error = unsafe {
            SetSecurityInfo(
                handle,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION,
                user.sid(),
                null_mut(),
                null_mut(),
                null_mut(),
            )
        };
        if error != 0 {
            return Err(io::Error::from_raw_os_error(error as i32).into());
        }
    }
    Ok(())
}

#[cfg(feature = "official-plugins")]
pub fn codex_pipe(path: &Path, expected: &Path) -> Result<crate::codex_peer::Stream> {
    use tokio::net::windows::named_pipe::ClientOptions;
    use windows_sys::Win32::{
        Storage::FileSystem::SECURITY_IDENTIFICATION,
        System::{
            Pipes::GetNamedPipeServerProcessId,
            Threading::{
                OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
            },
        },
    };
    ensure!(
        path.as_os_str()
            .to_string_lossy()
            .to_ascii_lowercase()
            .starts_with(r"\\.\pipe\"),
        "Codex Named Pipe 必须位于本机"
    );
    // Identification-only SQOS prevents the server from impersonating this process.
    let client = ClientOptions::new()
        .security_qos_flags(SECURITY_IDENTIFICATION)
        .open(path)?;
    let mut pid = 0;
    unsafe {
        ok(GetNamedPipeServerProcessId(
            client.as_raw_handle(),
            &mut pid,
        ))?;
    }
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return Err(io::Error::last_os_error().into());
    }
    let _process = unsafe { OwnedHandle::from_raw_handle(process) };
    let peer = User::read(process)?;
    let current = User::current()?;
    ensure!(
        unsafe { EqualSid(peer.sid(), current.sid()) } != 0,
        "Codex 对端用户不匹配"
    );
    let mut name = vec![0u16; 32768];
    let mut len = name.len() as u32;
    unsafe {
        ok(QueryFullProcessImageNameW(
            process,
            0,
            name.as_mut_ptr(),
            &mut len,
        ))?;
    }
    let actual = PathBuf::from(OsString::from_wide(&name[..len as usize])).canonicalize()?;
    let expected = expected.canonicalize()?;
    let a = wide(&actual);
    let b = wide(&expected);
    ensure!(
        unsafe { CompareStringOrdinal(a.as_ptr(), -1, b.as_ptr(), -1, 1) } == CSTR_EQUAL,
        "Codex 对端程序不匹配"
    );
    Ok(Box::new(client))
}
