
var reader;
var outputDone, outputStream;
var port; //web serial port object

async function webserialInit(baud, deviceInterface) {
    console.log("webserialInit()", baud);
    port = await navigator.serial.requestPort(); //prompt user to select a serial port
    await port.open({ baudRate: baud }); //open the port at the selected baud rate

    //app specific action
    pushToConsole("Connected to web serial port.");
    deviceInterface.port = port;
    deviceInterface.port.isOpen = true;
    deviceInterface.port.write = write; //attach custom function to transmit data to device

    //setup serial reception
    reader = port.readable.getReader();
    readLoop(deviceInterface);
}

async function write(data) {
    // console.log("write()", typeof data, data);
    const writer = port.writable.getWriter();
    if (typeof data === 'string') {
        const encoder = new TextEncoder();
        await writer.write(encoder.encode(data));
    }
    else {
        await writer.write(Uint8Array.from(data));
    }
    writer.releaseLock();
}

async function readLoop(deviceInterface) {
    while (true) {
        try {
            const { value, done } = await reader.read();
            if (value) {
                // console.log(value);
                deviceInterface.receiveData(value); //transfer to Aurora Device Interface
            }
            if (done) {
                console.log("READ DONE");
                reader.releaseLock();
                break;
            }
        }
        catch (e) {
            console.log(e);
        }
    }
}

async function closeWebSerialPort() {
    console.log("closeWebSerialPort()");
    if (reader) {
        await reader.cancel();
        // await inputDone.catch(() => { });
        reader = null;
        // inputDone = null;
    }
    // if (outputStream) {
    //     await outputStream.getWriter().close();
    //     await outputDone;
    //     // outputStream = null;
    //     // outputDone = null;
    // }
    await port.close();
    port = null;

    deviceInterface.port.isOpen = false;
    uxUpdate();
}