//! Unified error type. Every `#[tauri::command]` returns `AppResult<T>`; the error is
//! serialised as `{ code, message, details }` which the TypeScript side (`toAppError`)
//! understands.

use serde::{Serialize, Serializer};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("application not found: {0}")]
    AppNotFound(String),
    #[error("registry error: {0}")]
    Registry(String),
    #[error("path not found: {0}")]
    PathNotFound(String),
    #[error("refusing to touch protected path: {0}")]
    ProtectedPath(String),
    #[error("administrator rights required: {0}")]
    ElevationRequired(String),
    #[error("invalid uninstall command: {0}")]
    InvalidCommand(String),
    #[error("backup failed: {0}")]
    Backup(String),
    #[error("backup not found: {0}")]
    BackupNotFound(String),
    #[error("process error: {0}")]
    Process(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialisation error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Other(String),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            AppError::AppNotFound(_) => "APP_NOT_FOUND",
            AppError::Registry(_) => "REGISTRY",
            AppError::PathNotFound(_) => "PATH_NOT_FOUND",
            AppError::ProtectedPath(_) => "PROTECTED_PATH",
            AppError::ElevationRequired(_) => "ELEVATION_REQUIRED",
            AppError::InvalidCommand(_) => "INVALID_COMMAND",
            AppError::Backup(_) => "BACKUP",
            AppError::BackupNotFound(_) => "BACKUP_NOT_FOUND",
            AppError::Process(_) => "PROCESS",
            AppError::Io(_) => "IO",
            AppError::Json(_) => "JSON",
            AppError::Other(_) => "UNKNOWN",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireError<'a> {
    code: &'a str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<String>,
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let details = match self {
            AppError::Io(e) => Some(format!("{e:?}")),
            _ => None,
        };
        WireError { code: self.code(), message: self.to_string(), details }.serialize(serializer)
    }
}

pub type AppResult<T> = Result<T, AppError>;
