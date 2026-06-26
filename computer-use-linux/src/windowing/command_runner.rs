use std::io;
use std::process::{Command, Output};

pub(crate) trait CommandRunner {
    fn output(&self, command: &mut Command) -> io::Result<Output>;
}

#[derive(Debug, Default)]
pub(crate) struct RealCommandRunner;

impl CommandRunner for RealCommandRunner {
    fn output(&self, command: &mut Command) -> io::Result<Output> {
        command.output()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::ffi::OsStr;
    use std::os::unix::process::ExitStatusExt;
    use std::process::ExitStatus;
    use std::sync::Mutex;

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(crate) struct CommandInvocation {
        pub(crate) program: String,
        pub(crate) args: Vec<String>,
        pub(crate) envs: Vec<(String, Option<String>)>,
    }

    impl CommandInvocation {
        fn from_command(command: &Command) -> Self {
            Self {
                program: command.get_program().to_string_lossy().into_owned(),
                args: command
                    .get_args()
                    .map(|arg| arg.to_string_lossy().into_owned())
                    .collect(),
                envs: command
                    .get_envs()
                    .map(|(key, value)| {
                        (
                            key.to_string_lossy().into_owned(),
                            value.map(|value| value.to_string_lossy().into_owned()),
                        )
                    })
                    .collect(),
            }
        }

        pub(crate) fn removes_env(&self, key: &str) -> bool {
            self.envs
                .iter()
                .any(|(name, value)| name == key && value.is_none())
        }

        pub(crate) fn program_is(&self, program: &str) -> bool {
            OsStr::new(&self.program) == OsStr::new(program)
        }
    }

    #[derive(Debug)]
    pub(crate) struct FakeCommandRunner {
        invocations: Mutex<Vec<CommandInvocation>>,
        outputs: Mutex<VecDeque<Output>>,
    }

    impl FakeCommandRunner {
        pub(crate) fn new(outputs: Vec<Output>) -> Self {
            Self {
                invocations: Mutex::new(Vec::new()),
                outputs: Mutex::new(outputs.into()),
            }
        }

        pub(crate) fn invocations(&self) -> Vec<CommandInvocation> {
            self.invocations
                .lock()
                .expect("fake command runner invocation mutex poisoned")
                .clone()
        }
    }

    impl CommandRunner for FakeCommandRunner {
        fn output(&self, command: &mut Command) -> io::Result<Output> {
            self.invocations
                .lock()
                .expect("fake command runner invocation mutex poisoned")
                .push(CommandInvocation::from_command(command));
            self.outputs
                .lock()
                .expect("fake command runner output mutex poisoned")
                .pop_front()
                .ok_or_else(|| io::Error::other("no fake command output"))
        }
    }

    pub(crate) fn output_with_status(code: i32, stdout: &str, stderr: &str) -> Output {
        Output {
            status: ExitStatus::from_raw(code),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }
}
