# IC-7300 Web Controller

Demo at https://dj7nt.de/ic
A browser-based web interface for controlling the Icom IC-7300 transceiver using the Web Serial API.

## Features

- **Read TRX State**: Displays current frequency and operating mode
- **Set Frequency**: Change the radio's frequency
- **Set Mode**: Change operating mode (LSB, USB, AM, CW, RTTY, FM, etc.)
- **PTT Control**: Push and release PTT via CAT commands
- **Auto-Polling**: Automatically updates frequency and mode every 2 seconds
- **Activity Log**: Shows all communication with the radio

## Requirements

- **Browser**: Chrome, Edge, or Opera (browsers with Web Serial API support)
- **IC-7300**: Connected via USB to your computer
- **CI-V Settings**: Default settings (19200 baud, address 0x94)

## Setup

1. **Configure IC-7300**:
   - Press `MENU`
   - Go to `SET` > `Connectors` > `CI-V`
   - Set `CI-V Baud Rate`: 19200 (default)
   - Set `CI-V Address`: 94h (default)
   - Set `CI-V Transceive`: ON (optional, for automatic updates)

2. **Connect USB Cable**:
   - Connect the IC-7300 to your computer via USB
   - The radio appears as a serial device

3. **Open the Interface**:
   - Open `index.html` in Chrome, Edge, or Opera
   - Click "Connect to IC-7300"
   - Select the IC-7300 serial port (usually "Standard" or similar)

## Usage

### Connecting
1. Click **Connect to IC-7300**
2. Select your IC-7300 from the serial port list
3. The interface will display the current frequency and mode

### Setting Frequency
1. Enter frequency in MHz (e.g., `14.074` for 14.074 MHz)
2. Click **Set Frequency**
3. The display will update with the new frequency

### Changing Mode
1. Select desired mode from dropdown
2. Click **Set Mode**
3. The display will update with the new mode

### PTT Control
1. Click **Push PTT** to activate transmit
2. Button will change to **Release PTT** and pulse orange
3. Click again to return to receive

### Activity Log
- Shows all commands sent and responses received
- Displays timestamps for each event
- Color-coded: green (success), red (errors), blue (transmit)

## Supported Modes

- LSB (Lower Sideband)
- USB (Upper Sideband)
- AM (Amplitude Modulation)
- CW (Morse Code)
- RTTY (Radio Teletype)
- FM (Frequency Modulation)
- CW-R (CW Reverse)
- RTTY-R (RTTY Reverse)

## Technical Details

### CI-V Protocol
- Uses Icom CI-V protocol over serial
- Default IC-7300 address: 0x94
- Controller address: 0xE0
- Baud rate: 19200

### Command Implementation
- `0x03`: Read operating frequency
- `0x04`: Read operating mode
- `0x05`: Set operating frequency
- `0x06`: Set operating mode
- `0x1C 00`: PTT control

### Data Format
- Frequencies: 10-digit BCD format, little-endian
- Modes: Single byte mode code + filter setting

## Troubleshooting

**Can't connect:**
- Ensure you're using Chrome, Edge, or Opera
- Check that the IC-7300 USB cable is connected
- Verify the radio is powered on
- Try closing other software that might use the serial port

**Commands not working:**
- Verify CI-V settings on the radio
- Check baud rate is set to 19200
- Ensure CI-V address is 94h (default)

**No frequency/mode display:**
- Wait a few seconds after connecting
- Check the activity log for errors
- Try clicking Disconnect and reconnecting

## Browser Compatibility

✅ Chrome 89+
✅ Edge 89+
✅ Opera 75+
❌ Firefox (Web Serial API not supported)
❌ Safari (Web Serial API not supported)

## Security Note

This interface requires user permission to access serial ports. You must explicitly grant permission when clicking "Connect to IC-7300".

## License

Free to use and modify for amateur radio purposes.
