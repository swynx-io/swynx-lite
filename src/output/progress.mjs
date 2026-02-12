// src/output/progress.mjs
// Braille spinner on stderr for interactive mode

const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class ProgressSpinner {
  constructor(options = {}) {
    this.active = false;
    this.frame = 0;
    this.interval = null;
    this.message = '';
    this.noColor = options.noColor || false;
    this.enabled = options.enabled !== false && process.stderr.isTTY;
  }

  start(message = '') {
    if (!this.enabled) return;
    this.active = true;
    this.message = message;
    this.interval = setInterval(() => this._render(), 80);
    this._render();
  }

  update(progress) {
    if (!this.enabled) return;
    if (progress.message) {
      this.message = progress.message;
    }
    if (progress.phase === 'done') {
      this.stop();
    }
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    // Clear the spinner line
    if (this.enabled) {
      process.stderr.write('\r\x1b[K');
    }
  }

  _render() {
    if (!this.active) return;
    const spinner = BRAILLE[this.frame % BRAILLE.length];
    this.frame++;

    const dim = this.noColor ? '' : '\x1b[2m';
    const reset = this.noColor ? '' : '\x1b[0m';

    process.stderr.write(`\r\x1b[K  ${dim}${spinner} ${this.message}${reset}`);
  }
}
