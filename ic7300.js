// IC-7300 Web Serial Controller
// Implements CAT control for Icom IC-7300 transceiver

// Toggle API key visibility
function toggleApiKeyVisibility() {
    const input = document.getElementById('wavelogApiKey');
    const icon = document.getElementById('eyeIcon');

    if (input.type === 'password') {
        input.type = 'text';
        icon.textContent = '👁‍🗨';
    } else {
        input.type = 'password';
        icon.textContent = '👁';
    }
}

let port = null;
let reader = null;
let writer = null;
let readableStreamClosed = null;
let writableStreamClosed = null;
let isConnected = false;
let pttActive = false;
let statusPollInterval = null;
let lastPowerReading = 0;
let lastPowerReadingTime = 0;

// Settings with defaults
let IC7300_ADDRESS = 0x94;
const CONTROLLER_ADDRESS = 0xE0;
let BAUD_RATE = 19200;

// Wavelog settings
let WAVELOG_URL = '';
let WAVELOG_API_KEY = '';
let WAVELOG_ENABLED = false;

// Track last known values to detect changes
let lastFrequencyHz = null;
let lastModeCode = null;
let wavelogDebounceTimer = null; // Timer for debouncing Wavelog updates
const WAVELOG_DEBOUNCE_MS = 500; // Wait 500ms after last change before sending

// Settings storage key
const SETTINGS_KEY = 'ic7300_settings';

// Command codes
const CMD_READ_FREQ = 0x03;
const CMD_READ_MODE = 0x04;
const CMD_WRITE_FREQ = 0x05;
const CMD_WRITE_MODE = 0x06;
const CMD_PTT = 0x1C;
const CMD_READ_TRANSCEIVE = 0x00;
const CMD_READ_SMETER = 0x15;  // Read S-meter/Power meter
const CMD_READ_OPERATING_STATUS = 0x1C;  // Read operating status (TX/RX)
const CMD_SEND_CW = 0x17;  // Send CW message (NOT SUPPORTED ON IC-7300!)
const CMD_SET_KEYER_SPEED = 0x14;  // Set/read keyer speed
const CMD_MEMORY_KEYER = 0x1A;  // Extended command for memory keyer

// Mode codes
const MODES = {
    '00': 'LSB',
    '01': 'USB',
    '02': 'AM',
    '03': 'CW',
    '04': 'RTTY',
    '05': 'FM',
    '07': 'CW-R',
    '08': 'RTTY-R'
};

// Logging function
function log(message, type = 'info') {
    const logDiv = document.getElementById('log');
    const timestamp = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.textContent = `[${timestamp}] ${message}`;
    if (type === 'error') entry.style.color = '#f44336';
    if (type === 'success') entry.style.color = '#4CAF50';
    if (type === 'tx') entry.style.color = '#2196F3';
    logDiv.appendChild(entry);
    logDiv.scrollTop = logDiv.scrollHeight;

    // Keep only last 50 entries
    while (logDiv.children.length > 50) {
        logDiv.removeChild(logDiv.firstChild);
    }
}

// Convert frequency in Hz to IC-7300 BCD format
function frequencyToBCD(freqHz) {
    // IC-7300 expects 10 BCD digits (5 bytes) in little-endian
    // Format: Hz (1s, 10s), kHz (1s, 10s, 100s), MHz (1s, 10s, 100s), GHz (1s, 10s)
    const freqStr = freqHz.toString().padStart(10, '0');
    const bcd = [];

    // Pack pairs of digits into BCD bytes, little-endian (least significant first)
    for (let i = 0; i < 5; i++) {
        const lowDigit = parseInt(freqStr[9 - (i * 2)]);      // rightmost digit
        const highDigit = parseInt(freqStr[9 - (i * 2) - 1]);  // next digit left
        bcd.push((highDigit << 4) | lowDigit);
    }

    return bcd;
}

// Convert BCD format to frequency in Hz
function bcdToFrequency(bcd) {
    let freqStr = '';

    for (let i = bcd.length - 1; i >= 0; i--) {
        const high = (bcd[i] >> 4) & 0x0F;
        const low = bcd[i] & 0x0F;
        freqStr += high.toString() + low.toString();
    }

    return parseInt(freqStr);
}

// Calculate checksum (not used by IC-7300, but some may enable it)
function calculateChecksum(data) {
    // Not typically needed for IC-7300
    return 0;
}

// Build CI-V command
function buildCommand(cmd, data = []) {
    const packet = [
        0xFE, 0xFE,           // Preamble
        IC7300_ADDRESS,        // To IC-7300
        CONTROLLER_ADDRESS,    // From controller
        cmd,                   // Command
        ...data,
        0xFD                   // End of message
    ];
    return new Uint8Array(packet);
}

// Parse CI-V response
function parseResponse(data) {
    // Check for valid CI-V packet
    if (data.length < 6) return null;
    if (data[0] !== 0xFE || data[1] !== 0xFE) return null;
    if (data[data.length - 1] !== 0xFD) return null;

    const from = data[2];
    const to = data[3];
    const cmd = data[4];
    const payload = Array.from(data.slice(5, -1));

    return { from, to, cmd, payload };
}

// Connect to serial port
async function connect() {
    try {
        // Save current settings before connecting
        if (!saveSettings()) {
            return;
        }

        // Request a port
        port = await navigator.serial.requestPort();

        // Open the port with configured settings
        await port.open({
            baudRate: BAUD_RATE,
            dataBits: 8,
            stopBits: 1,
            parity: 'none',
            flowControl: 'none'
        });

        log('Connected: Baud=' + BAUD_RATE + ', CI-V=0x' + IC7300_ADDRESS.toString(16).toUpperCase(), 'success');

        // Set up writer for binary data
        writer = port.writable.getWriter();

        // Set up reader for binary data
        reader = port.readable.getReader();

        // Update UI
        isConnected = true;
        updateConnectionStatus(true);

        // Start reading responses
        readLoop();

        // Start status polling
        startStatusPolling();

        // Initial status read
        setTimeout(() => {
            readFrequency();
            readMode();
            readSMeter();
        }, 500);

    } catch (error) {
        log('Connection failed: ' + error.message, 'error');
        console.error('Connection error:', error);
    }
}

// Disconnect from serial port
async function disconnect() {
    try {
        stopStatusPolling();

        if (reader) {
            await reader.cancel();
            reader = null;
        }

        if (writer) {
            await writer.close();
            writer = null;
        }

        if (port) {
            await port.close();
            port = null;
        }

        isConnected = false;
        updateConnectionStatus(false);
        log('Disconnected', 'info');
    } catch (error) {
        log('Disconnect error: ' + error.message, 'error');
        console.error('Disconnect error:', error);
    }
}

// Read loop for incoming data
async function readLoop() {
    const buffer = [];

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            // Add received bytes to buffer
            for (let byte of value) {
                buffer.push(byte);

                // Check if we have a complete packet (ends with 0xFD)
                if (byte === 0xFD && buffer.length >= 6) {
                    // Find the start of the packet
                    let startIdx = -1;
                    for (let i = buffer.length - 3; i >= 0; i--) {
                        if (buffer[i] === 0xFE && buffer[i + 1] === 0xFE) {
                            startIdx = i;
                            break;
                        }
                    }

                    if (startIdx >= 0) {
                        const packet = buffer.splice(startIdx);
                        handleResponse(new Uint8Array(packet));
                    }
                }
            }

            // Prevent buffer from growing too large
            if (buffer.length > 100) {
                buffer.splice(0, buffer.length - 50);
            }
        }
    } catch (error) {
        log('Read error: ' + error.message, 'error');
        console.error('Read error:', error);
    }
}

// Handle received response
function handleResponse(data) {
    // Log received data for debugging
    const hex = Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ');
    log('RX: ' + hex, 'info');

    const response = parseResponse(data);
    if (!response) {
        log('Invalid response packet', 'error');
        return;
    }

    // Check for ACK/NAK
    if (response.cmd === 0xFB) {
        log('Command acknowledged', 'success');
        return;
    }

    if (response.cmd === 0xFA) {
        log('Command rejected (NAK)', 'error');
        return;
    }

    // Handle frequency response
    if (response.cmd === CMD_READ_FREQ) {
        if (response.payload.length >= 5) {
            const freqHz = bcdToFrequency(response.payload.slice(0, 5));
            const freqMHz = (freqHz / 1000000).toFixed(6);
            document.getElementById('freqDisplay').textContent = freqMHz + ' MHz';
            log('Frequency: ' + freqMHz + ' MHz', 'success');

            // Check if frequency changed
            if (lastFrequencyHz !== null && lastFrequencyHz !== freqHz) {
                onRadioStateChanged();
            }
            lastFrequencyHz = freqHz;
        }
    }

    // Handle mode response
    if (response.cmd === CMD_READ_MODE) {
        if (response.payload.length >= 1) {
            const modeCode = response.payload[0];
            const modeCodeHex = modeCode.toString(16).padStart(2, '0').toUpperCase();
            const modeName = MODES[modeCodeHex] || 'Unknown';
            document.getElementById('modeDisplay').textContent = modeName;
            log('Mode: ' + modeName, 'success');

            // Check if mode changed
            if (lastModeCode !== null && lastModeCode !== modeCode) {
                onRadioStateChanged();
            }
            lastModeCode = modeCode;
        }
    }

    // Handle S-meter/Power meter response
    if (response.cmd === CMD_READ_SMETER) {
        if (response.payload.length >= 3) {
            const subCmd = response.payload[0];
            const valueHigh = response.payload[1];
            const valueLow = response.payload[2];
            const value = (valueHigh << 8) | valueLow;

            // Sub-command 0x02 = S-meter (RX), 0x11 = Power meter (TX)
            if (subCmd === 0x02) {
                // S-meter value - display only when in RX
                if (!pttActive) {
                    updateBargraph(value, 'rx');
                }
            } else if (subCmd === 0x11) {
                // Power meter value - display only when in TX
                if (pttActive) {
                    updateBargraph(value, 'tx');
                }
            }
        }
    }

    // Handle operating status response (TX/RX state)
    if (response.cmd === CMD_READ_OPERATING_STATUS) {
        if (response.payload.length >= 2) {
            const subCmd = response.payload[0];
            if (subCmd === 0x00) {
                // PTT status: 0x00 = RX, 0x01 = TX
                const txState = response.payload[1];
                const newPttState = (txState === 0x01);

                if (pttActive !== newPttState) {
                    pttActive = newPttState;
                    updatePTTButton();
                    log(newPttState ? 'RX → TX (detected)' : 'TX → RX', newPttState ? 'success' : 'info');
                }
            }
        }
    }

    // Handle CW send command response
    if (response.cmd === CMD_SEND_CW) {
        console.log('CW command response received:', response);
    }
}

// Send command to radio
async function sendCommand(cmd, data = []) {
    if (!writer || !isConnected) {
        log('Not connected', 'error');
        return false;
    }

    try {
        const command = buildCommand(cmd, data);

        // Write binary data directly
        await writer.write(command);

        const hex = Array.from(command).map(b => b.toString(16).padStart(2, '0')).join(' ');
        log('TX: ' + hex, 'tx');

        return true;
    } catch (error) {
        log('Send error: ' + error.message, 'error');
        console.error('Send error:', error);
        return false;
    }
}

// Read frequency from radio
async function readFrequency() {
    await sendCommand(CMD_READ_FREQ);
}

// Read mode from radio
async function readMode() {
    await sendCommand(CMD_READ_MODE);
}

// Read S-meter (RX signal strength)
async function readSMeter() {
    await sendCommand(CMD_READ_SMETER, [0x02]);  // Sub-command 0x02 for S-meter
}

// Read Power meter (TX power)
async function readPowerMeter() {
    await sendCommand(CMD_READ_SMETER, [0x11]);  // Sub-command 0x11 for Power meter
}

// Read operating status (TX/RX state)
async function readOperatingStatus() {
    await sendCommand(CMD_READ_OPERATING_STATUS, [0x00]);  // Sub-command 0x00 for PTT/TX status
}

// Set keyer speed (WPM)
async function setKeyerSpeed(wpm) {
    if (!isConnected) {
        log('Not connected to radio', 'error');
        return;
    }

    // Clamp WPM to valid range (6-48 WPM for IC-7300)
    wpm = Math.max(6, Math.min(48, wpm));

    // Convert WPM to BCD format (2 digits)
    // For IC-7300: speed values are 6-48, stored as BCD
    const tens = Math.floor(wpm / 10);
    const ones = wpm % 10;
    const bcdHigh = tens & 0x0F;
    const bcdLow = ones & 0x0F;

    // Pack into two bytes: 0x00 [BCD value]
    // BCD format: high nibble = tens, low nibble = ones
    const bcd1 = 0x00;  // High byte (always 0x00 for speeds 6-48)
    const bcd2 = (bcdHigh << 4) | bcdLow;  // Low byte

    console.log(`Setting keyer speed to ${wpm} WPM (BCD: 0x${bcd1.toString(16).padStart(2, '0')} 0x${bcd2.toString(16).padStart(2, '0')})`);
    log(`Setting keyer speed to ${wpm} WPM`);

    // Command: 0x14 (set), 0x0C (keyer speed), [BCD high], [BCD low]
    await sendCommand(CMD_SET_KEYER_SPEED, [0x0C, bcd1, bcd2]);
}

// Send CW message
async function sendCWMessage(message) {
    if (!isConnected) {
        log('Not connected to radio', 'error');
        return;
    }

    // Convert message to uppercase (IC-7300 CW keyer uses uppercase)
    message = message.toUpperCase();

    log(`Sending CW: "${message}"`);
    console.log('=== Starting CW transmission ===');

    // Disable send button during transmission
    const sendBtn = document.getElementById('sendCWBtn');
    if (sendBtn) {
        sendBtn.disabled = true;
        sendBtn.textContent = 'Sending...';
    }

    try {
        // Send each character
        for (let i = 0; i < message.length; i++) {
            const char = message[i];
            const charCode = char.charCodeAt(0);

            // Build the command manually to inspect it
            const packet = [
                0xFE, 0xFE,           // Preamble
                IC7300_ADDRESS,        // To IC-7300
                CONTROLLER_ADDRESS,    // From controller
                CMD_SEND_CW,           // 0x17
                charCode,              // Character to send
                0xFD                   // End of message
            ];

            const hex = packet.map(b => '0x' + b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
            console.log(`[${i+1}/${message.length}] Char '${char}' (${charCode}): ${hex}`);

            // Send the character
            const success = await sendCommand(CMD_SEND_CW, [charCode]);

            if (!success) {
                log('Failed to send character: ' + char, 'error');
                break;
            }

            // Wait between characters to allow the radio to key
            await new Promise(resolve => setTimeout(resolve, 150));
        }

        console.log('=== CW transmission complete ===');
        log('CW message transmission complete');
    } catch (error) {
        log('Error sending CW: ' + error.message, 'error');
        console.error('CW send error:', error);
    }

    // Re-enable button
    if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send CW';
    }
}


// Update bargraph display
function updateBargraph(rawValue, mode) {
    const meterValue = document.getElementById('meterValue');
    const meterLabel = document.getElementById('meterLabel');
    const segments = document.querySelectorAll('.bar-segment');

    let level = 0;  // 0-15 for bargraph segments
    let displayText = '---';

    if (mode === 'rx') {
        // S-meter: 0=S0, 120=S9, 241=S9+60dB
        meterLabel.textContent = 'S-METER (RX)';

        if (rawValue <= 120) {
            // S0 to S9
            const sUnits = rawValue / 13.3;  // 0-9
            level = Math.floor(sUnits);
            displayText = 'S' + Math.floor(sUnits);
        } else {
            // S9+ (over S9)
            const over = Math.round((rawValue - 120) / 2);
            level = 9 + Math.min(Math.floor(over / 10), 6);  // 9-15 (S9 to S9+60)
            displayText = 'S9+' + over;
        }
    } else if (mode === 'tx') {
        // Power meter: map 0-255 to watts and bargraph
        meterLabel.textContent = 'POWER (TX)';
        const powerWatts = Math.round(rawValue / 2.55);  // 0-100W
        displayText = powerWatts + 'W';

        // Map power to bargraph (0-100W across 15 segments)
        level = Math.floor(powerWatts / 6.67);  // 0-15
    }

    // Update text display
    meterValue.textContent = displayText;

    // Update bargraph segments
    segments.forEach((segment, index) => {
        if (index < level) {
            segment.classList.add('active');
        } else {
            segment.classList.remove('active');
        }
    });
}

// Set frequency
async function setFrequency() {
    const freqInput = document.getElementById('freqInput').value;
    if (!freqInput) {
        log('Please enter a frequency', 'error');
        return;
    }

    try {
        const freqMHz = parseFloat(freqInput);
        const freqHz = Math.round(freqMHz * 1000000);

        if (freqHz < 1000000 || freqHz > 60000000) {
            log('Frequency out of range (1-60 MHz)', 'error');
            return;
        }

        const bcd = frequencyToBCD(freqHz);
        await sendCommand(CMD_WRITE_FREQ, bcd);

        log('Setting frequency to ' + freqMHz + ' MHz', 'info');

        // Read back after a short delay
        setTimeout(readFrequency, 200);
    } catch (error) {
        log('Invalid frequency format', 'error');
    }
}

// Set mode
async function setMode() {
    const modeSelect = document.getElementById('modeSelect');
    const modeCode = parseInt(modeSelect.value, 16);

    await sendCommand(CMD_WRITE_MODE, [modeCode, 0x01]); // 0x01 = default filter

    log('Setting mode to ' + MODES[modeSelect.value], 'info');

    // Read back after a short delay
    setTimeout(readMode, 200);
}

// Toggle PTT
async function togglePTT() {
    if (!pttActive) {
        // Push PTT
        await sendCommand(CMD_PTT, [0x00, 0x01]);
        pttActive = true;
        updatePTTButton();
        log('PTT activated', 'info');
    } else {
        // Release PTT
        await sendCommand(CMD_PTT, [0x00, 0x00]);
        pttActive = false;
        updatePTTButton();
        log('PTT released', 'info');
    }
}

// Update PTT button state
function updatePTTButton() {
    const pttBtn = document.getElementById('pttBtn');

    if (pttActive) {
        pttBtn.textContent = 'Release PTT';
        pttBtn.classList.add('ptt-active');
    } else {
        pttBtn.textContent = 'Push PTT';
        pttBtn.classList.remove('ptt-active');
    }
}

// Morse code timing and encoding
const MORSE_CODE = {
    'A': '.-',    'B': '-...',  'C': '-.-.',  'D': '-..',   'E': '.',
    'F': '..-.',  'G': '--.',   'H': '....',  'I': '..',    'J': '.---',
    'K': '-.-',   'L': '.-..',  'M': '--',    'N': '-.',    'O': '---',
    'P': '.--.',  'Q': '--.-',  'R': '.-.',   'S': '...',   'T': '-',
    'U': '..-',   'V': '...-',  'W': '.--',   'X': '-..-',  'Y': '-.--',
    'Z': '--..',  '0': '-----', '1': '.----', '2': '..---', '3': '...--',
    '4': '....-', '5': '.....', '6': '-....', '7': '--...', '8': '---..',
    '9': '----.',  '/': '-..-.',  '?': '..--..', '.': '.-.-.-',
    ',': '--..--', '=': '-...-', '+': '.-.-.', '-': '-....-',
    ' ': ' '  // Space between words
};

let cwKeying = false;  // Flag to track if CW is being sent

// Calculate timing based on WPM
function getCWTiming(wpm) {
    // Standard PARIS timing: 1 dot unit = 1200ms / WPM
    const dotDuration = 1200 / wpm;
    return {
        dot: dotDuration,
        dash: dotDuration * 3,
        symbolSpace: dotDuration,      // Space between dots/dashes
        letterSpace: dotDuration * 3,  // Space between letters
        wordSpace: dotDuration * 7     // Space between words
    };
}

// Key down (CW key closed)
async function keyDown() {
    if (!port) return;

    const keyLine = document.getElementById('cwKeyLine').value;

    console.log(`Key DOWN (${keyLine})`);

    if (keyLine === 'dtr') {
        await port.setSignals({ dataTerminalReady: true });
    } else if (keyLine === 'rts') {
        await port.setSignals({ requestToSend: true });
    }
}

// Key up (CW key open)
async function keyUp() {
    if (!port) return;

    const keyLine = document.getElementById('cwKeyLine').value;

    console.log(`Key UP (${keyLine})`);

    if (keyLine === 'dtr') {
        await port.setSignals({ dataTerminalReady: false });
    } else if (keyLine === 'rts') {
        await port.setSignals({ requestToSend: false });
    }
}

// Send a single morse character
async function sendMorseChar(char, timing) {
    const morse = MORSE_CODE[char.toUpperCase()];

    if (!morse) {
        console.log(`Skipping unknown character: ${char}`);
        return;
    }

    if (morse === ' ') {
        // Word space (already have letter space, add 4 more units)
        await new Promise(resolve => setTimeout(resolve, timing.wordSpace - timing.letterSpace));
        return;
    }

    // Send each dot/dash
    for (let i = 0; i < morse.length; i++) {
        if (!cwKeying) break;  // Allow interruption

        const symbol = morse[i];
        const duration = symbol === '.' ? timing.dot : timing.dash;

        // Key down
        await keyDown();
        await new Promise(resolve => setTimeout(resolve, duration));

        // Key up
        await keyUp();

        // Space between symbols (if not last symbol)
        if (i < morse.length - 1) {
            await new Promise(resolve => setTimeout(resolve, timing.symbolSpace));
        }
    }

    // Space between letters
    await new Promise(resolve => setTimeout(resolve, timing.letterSpace));
}

// Send CW message using DTR keying
async function sendCWMessage(message) {
    if (!isConnected || !port) {
        log('Not connected to radio', 'error');
        return;
    }

    message = message.toUpperCase().trim();
    if (!message) {
        log('Please enter a CW message', 'error');
        return;
    }

    // Get WPM setting
    const wpm = parseInt(document.getElementById('cwWPM').value) || 20;
    const timing = getCWTiming(wpm);

    log(`Sending CW: "${message}" at ${wpm} WPM via DTR keying`);
    console.log(`=== Starting CW transmission (DTR keying) ===`);
    console.log(`WPM: ${wpm}, Dot: ${timing.dot.toFixed(1)}ms, Dash: ${timing.dash.toFixed(1)}ms`);

    // Disable send button during transmission
    const sendBtn = document.getElementById('sendCWBtn');
    const stopBtn = document.getElementById('stopCWBtn');
    if (sendBtn) {
        sendBtn.disabled = true;
        sendBtn.textContent = 'Sending...';
    }
    if (stopBtn) {
        stopBtn.disabled = false;
    }

    cwKeying = true;

    try {
        // Activate PTT before sending CW
        console.log('Activating PTT...');
        await sendCommand(CMD_PTT, [0x00, 0x01]);
        pttActive = true;
        updatePTTButton();

        // Small delay to let PTT settle
        await new Promise(resolve => setTimeout(resolve, 100));

        // Send each character
        for (let i = 0; i < message.length && cwKeying; i++) {
            const char = message[i];
            console.log(`[${i+1}/${message.length}] Sending '${char}' (${MORSE_CODE[char] || 'unknown'})`);
            await sendMorseChar(char, timing);
        }

        console.log('=== CW transmission complete ===');
        log(cwKeying ? 'CW message sent' : 'CW transmission stopped');
    } catch (error) {
        log('Error sending CW: ' + error.message, 'error');
        console.error('CW send error:', error);
    }

    cwKeying = false;

    // Make sure key is up
    await keyUp();

    // Small delay before releasing PTT
    await new Promise(resolve => setTimeout(resolve, 100));

    // Release PTT
    console.log('Releasing PTT...');
    await sendCommand(CMD_PTT, [0x00, 0x00]);
    pttActive = false;
    updatePTTButton();

    // Re-enable button
    if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send CW';
    }
    if (stopBtn) {
        stopBtn.disabled = true;
    }
}

// Stop CW transmission
async function stopCW() {
    cwKeying = false;
    log('Stopping CW transmission...');

    // Make sure key is up
    await keyUp();

    // Release PTT
    await new Promise(resolve => setTimeout(resolve, 100));
    await sendCommand(CMD_PTT, [0x00, 0x00]);
    pttActive = false;
    updatePTTButton();
}

// UI wrapper function to send CW
async function sendCW() {
    const message = document.getElementById('cwMessage').value;
    await sendCWMessage(message);
}

// Clear CW message
function clearCWMessage() {
    document.getElementById('cwMessage').value = '';
}

// Start polling for status
function startStatusPolling() {
    // Poll every 300ms for responsive meter updates
    statusPollInterval = setInterval(() => {
        if (isConnected) {
            // Read operating status to get TX/RX state
            readOperatingStatus();

            // Read appropriate meter based on current state
            if (pttActive) {
                setTimeout(readPowerMeter, 100);
            } else {
                setTimeout(readSMeter, 100);
            }

            // Read frequency and mode less frequently
            if (Math.random() < 0.15) {  // About every 2 seconds
                setTimeout(() => {
                    readFrequency();
                    setTimeout(readMode, 100);
                }, 200);
            }
        }
    }, 300);
}

// Stop polling
function stopStatusPolling() {
    if (statusPollInterval) {
        clearInterval(statusPollInterval);
        statusPollInterval = null;
    }
}

// Update connection status in UI
function updateConnectionStatus(connected) {
    const statusDiv = document.getElementById('status');
    const statusText = document.getElementById('statusText');
    const connectBtn = document.getElementById('connectBtn');
    const disconnectBtn = document.getElementById('disconnectBtn');
    const freqInput = document.getElementById('freqInput');
    const setFreqBtn = document.getElementById('setFreqBtn');
    const modeSelect = document.getElementById('modeSelect');
    const setModeBtn = document.getElementById('setModeBtn');
    const pttBtn = document.getElementById('pttBtn');
    const baudRateSelect = document.getElementById('baudRate');
    const civAddressInput = document.getElementById('civAddress');
    const cwKeyLine = document.getElementById('cwKeyLine');
    const cwWPM = document.getElementById('cwWPM');
    const cwMessage = document.getElementById('cwMessage');
    const sendCWBtn = document.getElementById('sendCWBtn');
    const stopCWBtn = document.getElementById('stopCWBtn');

    if (connected) {
        statusDiv.className = 'status connected';
        statusText.textContent = 'Connected';
        connectBtn.disabled = true;
        disconnectBtn.disabled = false;
        freqInput.disabled = false;
        setFreqBtn.disabled = false;
        modeSelect.disabled = false;
        setModeBtn.disabled = false;
        pttBtn.disabled = false;
        baudRateSelect.disabled = true;
        civAddressInput.disabled = true;
        cwKeyLine.disabled = false;
        cwWPM.disabled = false;
        cwMessage.disabled = false;
        sendCWBtn.disabled = false;
        stopCWBtn.disabled = true;
    } else {
        statusDiv.className = 'status disconnected';
        statusText.textContent = 'Disconnected';
        connectBtn.disabled = false;
        disconnectBtn.disabled = true;
        freqInput.disabled = true;
        setFreqBtn.disabled = true;
        modeSelect.disabled = true;
        setModeBtn.disabled = true;
        pttBtn.disabled = true;
        baudRateSelect.disabled = false;
        civAddressInput.disabled = false;
        cwKeyLine.disabled = true;
        cwWPM.disabled = true;
        cwMessage.disabled = true;
        sendCWBtn.disabled = true;
        stopCWBtn.disabled = true;
        document.getElementById('freqDisplay').textContent = '----.--- MHz';
        document.getElementById('modeDisplay').textContent = '---';
        document.getElementById('meterValue').textContent = '---';
        document.getElementById('meterLabel').textContent = 'S-METER (RX)';

        // Clear bargraph
        document.querySelectorAll('.bar-segment').forEach(segment => {
            segment.classList.remove('active');
        });
    }
}

// Settings management
function loadSettings() {
    try {
        const stored = localStorage.getItem(SETTINGS_KEY);
        if (stored) {
            const settings = JSON.parse(stored);
            BAUD_RATE = settings.baudRate || 19200;
            IC7300_ADDRESS = settings.civAddress || 0x94;
            WAVELOG_URL = settings.wavelogUrl || '';
            WAVELOG_API_KEY = settings.wavelogApiKey || '';
            WAVELOG_ENABLED = settings.wavelogEnabled || false;

            // Update UI
            document.getElementById('baudRate').value = BAUD_RATE;
            document.getElementById('civAddress').value = IC7300_ADDRESS.toString(16).toUpperCase();
            document.getElementById('wavelogUrl').value = WAVELOG_URL;
            document.getElementById('wavelogApiKey').value = WAVELOG_API_KEY;
            document.getElementById('wavelogEnabled').checked = WAVELOG_ENABLED;

            log('Settings loaded from storage', 'success');
        }
    } catch (error) {
        log('Error loading settings: ' + error.message, 'error');
    }
}

function saveSettings() {
    try {
        const baudRate = parseInt(document.getElementById('baudRate').value);
        const civAddressStr = document.getElementById('civAddress').value;
        const civAddress = parseInt(civAddressStr, 16);

        if (isNaN(civAddress) || civAddress < 0 || civAddress > 0xFF) {
            log('Invalid CI-V address (must be 00-FF hex)', 'error');
            return false;
        }

        BAUD_RATE = baudRate;
        IC7300_ADDRESS = civAddress;
        WAVELOG_URL = document.getElementById('wavelogUrl').value.trim();
        WAVELOG_API_KEY = document.getElementById('wavelogApiKey').value.trim();
        WAVELOG_ENABLED = document.getElementById('wavelogEnabled').checked;

        const settings = {
            baudRate: BAUD_RATE,
            civAddress: IC7300_ADDRESS,
            wavelogUrl: WAVELOG_URL,
            wavelogApiKey: WAVELOG_API_KEY,
            wavelogEnabled: WAVELOG_ENABLED
        };

        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        log('Settings saved', 'success');
        return true;
    } catch (error) {
        log('Error saving settings: ' + error.message, 'error');
        return false;
    }
}

function resetSettings() {
    try {
        localStorage.removeItem(SETTINGS_KEY);

        // Reset to defaults
        BAUD_RATE = 19200;
        IC7300_ADDRESS = 0x94;
        WAVELOG_URL = '';
        WAVELOG_API_KEY = '';
        WAVELOG_ENABLED = false;

        // Update UI
        document.getElementById('baudRate').value = BAUD_RATE;
        document.getElementById('civAddress').value = '94';
        document.getElementById('wavelogUrl').value = '';
        document.getElementById('wavelogApiKey').value = '';
        document.getElementById('wavelogEnabled').checked = false;

        log('Settings reset to defaults', 'success');
    } catch (error) {
        log('Error resetting settings: ' + error.message, 'error');
    }
}

// Auto-save settings when they change
document.addEventListener('DOMContentLoaded', () => {
    loadSettings();

    const baudRateSelect = document.getElementById('baudRate');
    const civAddressInput = document.getElementById('civAddress');
    const wavelogUrlInput = document.getElementById('wavelogUrl');
    const wavelogApiKeyInput = document.getElementById('wavelogApiKey');
    const wavelogEnabledCheck = document.getElementById('wavelogEnabled');

    baudRateSelect.addEventListener('change', saveSettings);
    civAddressInput.addEventListener('blur', saveSettings);
    wavelogUrlInput.addEventListener('blur', saveSettings);
    wavelogApiKeyInput.addEventListener('blur', saveSettings);
    wavelogEnabledCheck.addEventListener('change', saveSettings);

    // Validate CI-V address input
    civAddressInput.addEventListener('input', (e) => {
        e.target.value = e.target.value.replace(/[^0-9A-Fa-f]/g, '').toUpperCase().slice(0, 2);
    });
});

// Wavelog integration
async function sendToWavelog(frequency, mode) {
    if (!WAVELOG_ENABLED || !WAVELOG_URL || !WAVELOG_API_KEY) {
        return;
    }

    try {
        // Build Wavelog radio API endpoint
        const url = WAVELOG_URL.replace(/\/$/, '') + '/index.php/api/radio';

        // Map IC-7300 mode codes to Wavelog mode names
        const modeMap = {
            0x00: 'LSB',
            0x01: 'USB',
            0x02: 'AM',
            0x03: 'CW',
            0x04: 'RTTY',
            0x05: 'FM',
            0x07: 'CW',  // CW-R
            0x08: 'RTTY' // RTTY-R
        };

        const modeName = modeMap[mode] || 'USB';

        const data = {
            key: WAVELOG_API_KEY,
            radio: 'IC-7300',
            frequency: frequency,
            mode: modeName
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data)
        });

        if (response.ok) {
            log('Wavelog updated: ' + (frequency / 1000000).toFixed(6) + ' MHz ' + modeName, 'success');
        } else {
            log('Wavelog update failed: ' + response.status, 'error');
        }
    } catch (error) {
        log('Wavelog error: ' + error.message, 'error');
    }
}

// Called when frequency or mode changes
function onRadioStateChanged() {
    if (lastFrequencyHz !== null && lastModeCode !== null) {
        // Clear existing timer if any
        if (wavelogDebounceTimer) {
            clearTimeout(wavelogDebounceTimer);
        }

        // Set new timer to send after 500ms of no changes
        wavelogDebounceTimer = setTimeout(() => {
            sendToWavelog(lastFrequencyHz, lastModeCode);
            wavelogDebounceTimer = null;
        }, WAVELOG_DEBOUNCE_MS);
    }
}

// Check for Web Serial API support
if ('serial' in navigator) {
    log('Web Serial API supported', 'success');
} else {
    log('Web Serial API not supported in this browser', 'error');
    log('Please use Chrome, Edge, or Opera', 'error');
}
