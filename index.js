"use strict";

var auroraCMD; //Auora device interface
var dataSocket; //websocket to nodejs script. Used a 'transparent' bridge between the device interface and node serialport
var commSocket; //websocket to nodejs script. Sends and receives JSON messages containing commands
var device = {}; //object for connected hardware device
const baudRates = [9600, 19200, 38400, 57600, 115200, 230400, 250000, 500000, 1000000];

const TCPPORT = 23;
const TCPIP = '192.168.4.1';

var nledDeviceIDs;

fetch('./nled-deviceid.json')
    .then((responseConfig) => responseConfig.json())
    .then((jsonDevices) => {
        nledDeviceIDs = JSON.parse(JSON.stringify(jsonDevices));
    });

//======================================================================

function connectToDataSocket(callback) {
    console.log("connectToDataSocket()");

    try {
        if (dataSocket.readyState == 3) dataSocket = new WebSocket('ws://localhost:8080');
    }
    catch (e) {
        //errors if socket is undefined, so there is no socket object
        dataSocket = new WebSocket('ws://localhost:8080');
    }

    // Connection Opened
    dataSocket.addEventListener('open', (event) => {
        console.log('dataSocket connection opened')
        dataSocket.binaryType = "arraybuffer"; //send/receive as buffer/Uint8
        if (typeof callback == "function") callback();
    });

    dataSocket.addEventListener('message', (event) => {
        // console.log(event);
        // console.log('dataSocket Message:', new Uint8Array(event.data));
        // auroraCMD.receiveData(Uint8Array.from(event.data)); //transfer to Aurora Device Interface
        auroraCMD.receiveData(new Uint8Array(event.data)); //transfer to Aurora Device Interface
    });

    dataSocket.addEventListener('close', (event) => {
        console.log('dataSocket Close:', event);

    });
}

//======================================================================

function connectToCommSocket(callback) {
    console.log("connectToCommSocket()");

    try {
        if (commSocket.readyState == 3) commSocket = new WebSocket('ws://localhost:8081');
    }
    catch (e) {
        //errors if socket is undefined, so there is no socket object
        commSocket = new WebSocket('ws://localhost:8081');
    }
    // Connection opened

    commSocket.addEventListener('open', (event) => {
        console.log('commSocket connection opened');
        document.getElementById("app-connection-nodejs-status").innerText = "Connected";
        // commSocket.binaryType = "arraybuffer";
        if (typeof callback == "function") callback();
    });

    commSocket.addEventListener('message', (event) => {
        console.log('commSocket Message:', event.data);

        if (isJson(event.data)) {
            let json = JSON.parse(event.data);
            switch (json.cmd) {
                case "SCANPORTS":
                    document.getElementById("app-connection-nodejs-ports").innerHTML = ""; //clear all options
                    json.ports.map(e => {
                        const opt = document.createElement("option");
                        opt.value = opt.text = e;
                        document.getElementById("app-connection-nodejs-ports").add(opt);
                    });
                    break;
                case "CONNECT":
                    if (json.status == "success") {
                        pushToConsole("Connected to interface.");
                        auroraCMD.port = dataSocket;
                        auroraCMD.port.isOpen = true;
                        auroraCMD.port.write = dataSocket.send;
                        uxUpdate();
                    }
                    else if (json.status == "error") {
                        pushToConsole(json.message);
                    }
                    break;
                case "DISCONNECT":
                    auroraCMD.port.isOpen = false;
                    uxUpdate();
                    break;
            }
        }
        else {
            //not valid json
        }
    });

    commSocket.addEventListener('close', (event) => {
        console.log('commSocket Close:', event);
        document.getElementById("app-connection-nodejs-status").innerText = "Disconnected";
    });
}

//======================================================================

function isJson(str) {
    try {
        JSON.parse(str);
    } catch (e) {
        return false;
    }
    return true;
}
//======================================================================

function pushToConsole(msg) {
    document.getElementById("app-console-box").innerHTML = msg + "\n" + document.getElementById("app-console-box").innerHTML;
}

//======================================================================

document.addEventListener('DOMContentLoaded', () => {
    const baudRatesNodeJS = document.getElementById("app-connection-nodejs-baud");
    const baudRatesWebSerial = document.getElementById("app-connection-webserial-baud");

    baudRates.map(e => {
        const opt = document.createElement("option");
        opt.value = opt.text = e;
        baudRatesNodeJS.add(opt);
        baudRatesWebSerial.add(opt.cloneNode(true));
    });
    baudRatesNodeJS.selectedIndex = 0;
    baudRatesWebSerial.selectedIndex = 0;

    document.getElementById("app-connection-webserial-status").innerText = ("serial" in navigator) ? "Supported" : "Not Supported";
});

document.getElementById("app-connection-method").addEventListener('change', function () {
    const nodejs = document.getElementById("app-connection-nodejs");
    const webserial = document.getElementById("app-connection-webserial");
    const tcpip = document.getElementById("app-connection-tcpip");
    nodejs.classList.add("hide");
    webserial.classList.add("hide");
    tcpip.classList.add("hide");
    document.getElementById("app-connection-" + this.options[this.selectedIndex].value).classList.remove("hide");

    if (this.value == "nodejs" || this.value == "tcpip") {
        if (dataSocket == undefined) connectToDataSocket();
        else if (dataSocket.readyState != 1 && dataSocket.readyState != 3) connectToDataSocket();
        if (commSocket == undefined) connectToCommSocket();
        else if (commSocket.readyState != 1 && commSocket.readyState != 3) connectToCommSocket();
    }
    else {
        try {
            dataSocket.close();
        }
        catch (e) { }
        try {
            commSocket.close();
        }
        catch (e) { }
    }
});

document.getElementById("app-connection-connect").addEventListener('click', async function () {

    // let methodDD = document.getElementById("app-connection-method");
    // let connMethod = methodDD.options[methodDD.selectedIndex].value;
    let connMethod = document.getElementById("app-connection-method").value;
    let baud;
    let port;
    auroraCMD = new AuroraDeviceInterface(); //construct new

    if (connMethod == "nodejs") {
        baud = document.getElementById("app-connection-nodejs-baud").value;
        port = document.getElementById("app-connection-nodejs-ports").value;
        commSocket.send(JSON.stringify({ cmd: "CONNECT", method: "serial", port: port, baud: baud }));
    }
    else if (connMethod == "webserial") {
        baud = document.getElementById("app-connection-webserial-baud").value;
        //Web serial requires the user to select the serial port from a prompt. The name of the port is not returned or available.
        await webserialInit(baud, auroraCMD);
        port = "(prompt)"
    }
    else if (connMethod == "tcpip") {
        //extract the specified IP address and port number from the UX elements
        let ipValue = [];
        [...document.getElementById("app-connection-tcpip-adr").children].map(child => ipValue.push(child.value));
        let portValue = ipValue[4];
        ipValue = ipValue[0] + '.' + ipValue[1] + '.' + ipValue[2] + '.' + ipValue[3]
        commSocket.send(JSON.stringify({ cmd: "CONNECT", method: "tcpip", networkPort: portValue, ip: ipValue }));
    }

    console.log("Connect to Device at", baud, "on port: ", port);


    //User specified event callbacks
    auroraCMD.eventNoPort = function () {
        console.log("Aurora 'eventNoPort' callback");
        //Called when a command is issued and the specified port/interface is not available.
        //user defined function
    }

    auroraCMD.eventTimeout = function () {
        console.log("Aurora 'eventTimeout' callback");
        //Called when a device does not respond to a command after 3 retries
        //user defined function
    }

});

document.getElementById("app-connection-disconnect").addEventListener('click', async function () {
    let connMethod = document.getElementById("app-connection-method").value;
    if (connMethod == "nodejs") {
        commSocket.send(JSON.stringify({ cmd: "DISCONNECT" }));
    }
    else if (connMethod == "webserial") {
        closeWebSerialPort();
    }
});

document.getElementById("app-connection-nodejs-scan").addEventListener('click', function () {
    console.log("Scanning Serial Ports In NodeJS script");
    // console.log(dataSocket.readyState);
    // console.log(commSocket.readyState);
    if (dataSocket == undefined) connectToDataSocket();
    else if (dataSocket.readyState != 1 && dataSocket.readyState != 3) connectToDataSocket();
    if (commSocket == undefined) connectToCommSocket();
    else if (commSocket.readyState != 1 && commSocket.readyState != 3) connectToCommSocket();
    if (commSocket.readyState == 1) commSocket.send(JSON.stringify({ cmd: "SCANPORTS" }));
});

function uxUpdate() {
    if (auroraCMD.port.isOpen == false) {
        document.getElementById("app-connection-status").innerText = "Disconnected";
    }
    else {
        document.getElementById("app-connection-status").innerText = "Connected";
    }
}

//==============================================================================================================================

document.getElementById("app-playcontrols-onoff").addEventListener('click', function () {
    auroraCMD.setOnOff(pushToConsole("Success - Toggling On/Off"));
    //ADD DATA BYTES
});

document.getElementById("app-playcontrols-pause").addEventListener('click', function () {
    auroraCMD.setPause(pushToConsole("Success - Pause"));
});

document.getElementById("app-playcontrols-play").addEventListener('click', function () {
    auroraCMD.setPause(pushToConsole("Success - Play"));
});

document.getElementById("app-playcontrols-speedup").addEventListener('click', function () {
    auroraCMD.setSpeedIncrease(pushToConsole("Success - Speed Increase(Slower)"));
});

document.getElementById("app-playcontrols-speeddown").addEventListener('click', function () {
    auroraCMD.setSpeedDecrease(pushToConsole("Success - Speed Decrease(Faster)"));
});

document.getElementById("app-playcontrols-setspeed").addEventListener('click', function () {
    let speedVal = Number(document.getElementById("app-commandlist-setspeed-val").value);
    auroraCMD.setSpeed(speedVal, pushToConsole("Success - Set Speed to " + speedVal));
});

document.getElementById("app-playcontrols-intensity").addEventListener('change', function () {
    auroraCMD.setIntensity(this.value, pushToConsole("Success - Setting Intensity"));
});

document.getElementById("app-playcontrols-playpause").addEventListener('click', function () {
    auroraCMD.setPlayPauseToggle(pushToConsole("Success - Play/Pause Toggle"));
});

document.getElementById("app-playcontrols-next").addEventListener('click', function () {
    auroraCMD.setSequenceNext(pushToConsole("Success - Sequence Next"));
});

document.getElementById("app-playcontrols-previous").addEventListener('click', function () {
    auroraCMD.setSequencePrevious(pushToConsole("Success - Sequence Previous"));
});

document.getElementById("app-commandlist-setseqid").addEventListener('click', function () {
    let seqID = Number(document.getElementById("app-commandlist-setseqid-val").value);
    auroraCMD.setSequenceByID(seqID, pushToConsole("Success - Set Sequence ID to " + seqID));
});

document.getElementById("app-commandlist-setuserid").addEventListener('click', function () {
    let userID = Number(document.getElementById("app-commandlist-setuserid-val").value);
    auroraCMD.setSequenceByID(seqID, pushToConsole("Success - Set User ID to " + userID));
});

document.getElementById("app-commandlist-setseqidle").addEventListener('click', function () {
    auroraCMD.setIdleSequence(pushToConsole("Success - Set Sequence to Idle"));
});

document.getElementById("app-commandlist-blank").addEventListener('click', function () {
    auroraCMD.setOutputsBlank(pushToConsole("Success - Outputs Blanked/Cleared"));
});

document.getElementById("app-commandlist-serialnumber").addEventListener('click', function () {
    auroraCMD.requestSerialNumber(function (data) {
        //serial number arrives in 4 bytes, combined to make a 32-bit number
        //convert it to hexadecimal and store it is a string
        let str = data.map(v => decToHex(v).toUpperCase());
        device.serialNum = str.join("");
    });
});

document.getElementById("app-commandlist-deviceinfo").addEventListener('click', function () {
    auroraCMD.requestDeviceInfo(function (data) {
        // console.log(data);
        device.hardwareID = data[0];//NLED internal identification number.
        device.hardwareVer = data[1];//Hardware version, not accurate on most devices
        device.firmwareVer = data[2];//Firmware Version, major
        device.firmwareRev = data[3];//Firmware Version, minor
        device.bootloaderHardwareID = data[4]; //No usage. Should be the same as .hardwareID
        device.bootVer = data[5]; //Bootloader Version
        device.userIDNum = data[6]; //User ID number - this can be defined by the user, used to address and/or identify connected devices

        device.name = nledDeviceIDs[device.hardwareID];

        document.getElementById("app-connection-fwv").innerText = device.firmwareVer + "" + String.fromCharCode(97 + device.firmwareRev);
        document.getElementById("app-connection-device").innerText = device.name;
    });
});

document.getElementById("app-commandlist-defaultconfig").addEventListener('click', function () {
    auroraCMD.setDeviceConfigDefault(pushToConsole("Success - Device Configurations Set to Default"));
});

document.getElementById("app-commandlist-setpixelcolororder").addEventListener('click', function () {
    let colorOrderID = Number(document.getElementById("app-commandlist-setpixelcolororder-val").value);
    auroraCMD.setDeviceColorOrder(colorOrderID, pushToConsole("Success - Set Pixel Color Order to " + colorOrderID));
});

document.getElementById("app-commandlist-setpixelclone").addEventListener('click', function () {
    let cloneNum = Number(document.getElementById("app-commandlist-setpixelclone-val").value);
    auroraCMD.setPixelPacketClone(cloneNum, pushToConsole("Success - Set Pixel Packet Cloning to " + cloneNum));
});