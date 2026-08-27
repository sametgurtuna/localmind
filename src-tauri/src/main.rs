// Prevents console window on Windows under all conditions (debug and release)
#![windows_subsystem = "windows"]

fn main() {
  app_lib::run();
}

