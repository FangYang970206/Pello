pub mod files;
pub mod git;
pub mod i18n;
pub mod layout;
pub mod search;
pub mod paths;
pub mod preview;
pub mod pty;
pub mod resources;
pub mod shells;
pub mod ssh;
pub mod store;
pub mod temporary;
pub mod workbench;

pub fn random_id() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("system random");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7], bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    )
}

pub fn uid(prefix: &str) -> String {
    let mut bytes = [0u8; 4];
    getrandom::getrandom(&mut bytes).expect("system random");
    let alphabet = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut body = String::new();
    for byte in bytes {
        body.push(alphabet[(byte as usize) % alphabet.len()] as char);
    }
    // Match the short id length used by the renderer (`toString(36).slice(2, 7)`).
    let extra = bytes[0] % 36;
    body.push(alphabet[extra as usize] as char);
    format!("{prefix}{body}")
}
