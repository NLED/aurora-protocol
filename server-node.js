import { WebSocketServer } from 'ws';
import serialPort from 'serialport';
import net from 'node:net';

var dataSocket = new WebSocketServer({ port: 8080 }); //transparent bridge between the browser and the device
var commSocket = new WebSocketServer({ port: 8081 }); //commands to and from node server and browser

//Interface bridges the browser to the end device through a serial port, a TCP client, etc 
//  For TCP over Wifi ESP-Link by JeeLabs is a great transparent WiFi to Serial bridge
var bridge = {
    interface: null,
    isOpen: false
};

//=================================================================================================================

console.log("NLED Aurora Control Protocol Example Interface v3.0.0");
console.log("Starting NodeJS Server");

//=================================================================================================================

dataSocket.on('connection', function connection(ws) {
    console.log("Client Connected to dataSocket");
    dataSocket = ws;

    ws.on('message', function message(data) {
        console.log("dataSocket Client Sent:", bridge.isOpen, data);
        if (bridge.isOpen) {
            bridge.interface.write(data);
        }
    });

    ws.on('close', function message(event) {
        console.log("dataSocket Client Disconnected");
    });
});
//=================================================================================================================

commSocket.on('connection', function connection(ws) {
    console.log("Client Connected to commSocket");

    ws.on('message', function message(data) {
        console.log("commSocket Client Sent:", data);
        let decoded = new TextDecoder().decode(data);
        let json = JSON.parse(decoded);
        // console.log(json);

        switch (json.cmd) {
            case "SCANPORTS":
                serialPort.list().then(ports => {
                    //console.log(ports);
                    let jsonTX = {
                        cmd: "SCANPORTS",
                        ports: ports.map(e => e.path)
                    }
                    ws.send(JSON.stringify(jsonTX));
                });
                break;
            case "CONNECT":
                if (json.method == "serial") {
                    try {
                        console.log(bridge.isOpen);
                        if (bridge.isOpen) bridge.interface.close();
                    }
                    catch (e) { }

                    try {
                        bridge.interface = new serialPort(json.port, {
                            baudRate: Number(json.baud),
                            parity: 'none',
                            stopBits: 1,
                            dataBits: 8,
                            flowControl: false,
                            usePromises: true,
                        }, function (err) {
                            if (err) {
                                console.log('err', err.message);
                                ws.send(JSON.stringify({ cmd: "CONNECT", status: "error", message: err.message }));
                            }
                            else {
                                ws.send(JSON.stringify({ cmd: "CONNECT", status: "success" }));

                                bridge.interface.on('data', function (data) {
                                    console.log("Serial Data:", data);
                                    dataSocket.send(Uint8Array.from(data));
                                });

                                //Close errors will be emitted as an error event
                                bridge.interface.on('close', function () {
                                    ws.send(JSON.stringify({ cmd: "DISCONNECT" }));
                                });
                            }
                        });
                    }
                    catch (e) {
                        console.log(e)
                        ws.send(JSON.stringify({ cmd: "CONNECT", status: "error", message: "Port not found. Verify serial port selection." }))
                    }
                }
                else if (json.method == "tcpip") {
                    bridge.interface = net.createConnection(json.networkPort, json.ip, () => {
                        // 'connect' listener
                        console.log('TCPIP Connected To Server');
                        bridge.isOpen = true;
                        ws.send(JSON.stringify({ cmd: "CONNECT", status: "success" }));
                    });
                    bridge.interface.on('data', (data) => {
                        console.log("TCP Data:", data.toString());
                        dataSocket.send(Uint8Array.from(data));
                    });
                    bridge.interface.on('end', () => {
                        console.log('TCPIP disconnected from server');
                        ws.send(JSON.stringify({ cmd: "DISCONNECT", event: "end"}));
                    });

                    bridge.interface.on('error', (err) => {
                        console.log('TCPIP error', err);
                        ws.send(JSON.stringify({ cmd: "CONNECT", status: "error", message: err.message }));
                        bridge.isOpen = false;
                    });

                    bridge.interface.on('close', () => {
                        console.log('TCPIP Close');
                        bridge.isOpen = false;
                        ws.send(JSON.stringify({ cmd: "DISCONNECT", event: "close" }));
                    });
                }
                break;
            case "DISCONNECT":
                try {
                    if (bridge.isOpen) bridge.interface.close(); //closes serialport
                }
                catch (e) { }

                try {
                    if (bridge.isOpen) bridge.interface.end(); //closes TCP client
                }
                catch (e) { }

                break;
        } //end switch
    });

    ws.on('close', function message(event) {
        console.log("commSocket Client Disconnected");

    });
});

//=================================================================================================================