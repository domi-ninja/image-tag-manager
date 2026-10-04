//! Tie the native inference process to the desktop application's lifetime.
use std::process::Command;

pub fn configure(command: &mut Command) {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: The pre-exec hook calls only async-signal-safe libc functions,
        // without allocation or locks. Checking the parent closes the spawn race.
        let parent = unsafe { libc::getpid() };
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::getppid() != parent {
                    libc::_exit(1);
                }
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    let _ = command;
}

#[cfg(windows)]
pub fn attach(child: &std::process::Child) -> std::io::Result<std::os::windows::io::OwnedHandle> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    // SAFETY: The job handle is checked and immediately given a unique RAII
    // owner. All pointers refer to initialized structures of the specified size.
    unsafe {
        let raw = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if raw.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let handle = OwnedHandle::from_raw_handle(raw);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            raw,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const std::ffi::c_void,
            std::mem::size_of_val(&limits) as u32,
        ) == 0
            || AssignProcessToJobObject(raw, child.as_raw_handle()) == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(handle)
    }
}

pub struct ParentGuard {
    #[cfg(target_os = "linux")]
    _keep_alive: std::sync::mpsc::Sender<()>,
}

pub fn spawn(mut command: Command) -> std::io::Result<(std::process::Child, ParentGuard)> {
    #[cfg(target_os = "linux")]
    {
        let (result_tx, result_rx) = std::sync::mpsc::sync_channel(1);
        let (keep_alive, lifetime) = std::sync::mpsc::channel();
        // Linux's parent-death signal follows the spawning thread. Keep that
        // thread alive between classification batches, until the server drops.
        std::thread::spawn(move || {
            configure(&mut command);
            if result_tx.send(command.spawn()).is_ok() {
                let _ = lifetime.recv();
            }
        });
        let child = result_rx.recv().map_err(std::io::Error::other)??;
        Ok((
            child,
            ParentGuard {
                _keep_alive: keep_alive,
            },
        ))
    }
    #[cfg(not(target_os = "linux"))]
    {
        configure(&mut command);
        Ok((command.spawn()?, ParentGuard {}))
    }
}
