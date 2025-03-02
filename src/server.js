import  net from 'net';
import axios from 'axios'; // For HTTP requests
import config from '../config/config.js';

// Connection class to manage state
class Connection {
    constructor(socket) {
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        this.state = 'active'; // 'active', 'waiting_for_unbind_response', 'closed'
        this.waitingForUnbindResponse = false;
        this.sessionId = null; // Store session_id per connection
    }
}

function logMessage(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

// Create PDU header
function createPduHeader(commandId, commandStatus, sequenceNumber, bodyLength = 0) {
    const commandLength = 16 + bodyLength;
    const buffer = Buffer.alloc(16);
    buffer.writeUInt32BE(commandLength, 0);
    buffer.writeUInt32BE(commandId, 4);
    buffer.writeUInt32BE(commandStatus, 8);
    buffer.writeUInt32BE(sequenceNumber, 12);
    return buffer;
}

// Create bind_response PDU
function createBindResponse(sequenceNumber) {
    const systemId = 'server';
    const body = Buffer.from(systemId + '\0', 'utf8');
    return Buffer.concat([createPduHeader(0x80000009, 0x00000000, sequenceNumber, body.length), body]);
}

// Create deliver_sm PDU for USSD response
function createDeliverSm(sequenceNumber, message) {
    const sourceAddr = 'SERVER';
    const destinationAddr = 'CLIENT';
    const shortMessage = message;
    const body = Buffer.alloc(33 + shortMessage.length + 1); // Simplified mandatory fields
    body.writeUInt8(0, 0); // service_type
    body.writeUInt8(0, 1); // source_addr_ton
    body.writeUInt8(0, 2); // source_addr_npi
    body.write(sourceAddr + '\0', 3, 'utf8');
    body.writeUInt8(0, 3 + sourceAddr.length + 1); // dest_addr_ton
    body.writeUInt8(0, 4 + sourceAddr.length + 1); // dest_addr_npi
    body.write(destinationAddr + '\0', 5 + sourceAddr.length + 1, 'utf8');
    body.writeUInt8(0, 5 + sourceAddr.length + destinationAddr.length + 2); // esm_class
    body.writeUInt8(0, 6 + sourceAddr.length + destinationAddr.length + 2); // protocol_id
    body.writeUInt8(4, 7 + sourceAddr.length + destinationAddr.length + 2); // data_coding (ASCII)
    body.writeUInt32BE(0, 8 + sourceAddr.length + destinationAddr.length + 2); // registered_delivery
    body.write(shortMessage + '\0', 12 + sourceAddr.length + destinationAddr.length + 2, 'utf8');
    return Buffer.concat([createPduHeader(0x00000005, 0x00000000, sequenceNumber, body.length), body]);
}

// Create unbind PDU
function createUnbind(sequenceNumber) {
    return createPduHeader(0x00000006, 0x00000000, sequenceNumber);
}

// Parse PDU
function parsePdu(pduData) {
    const header = {
        commandLength: pduData.readUInt32BE(0),
        commandId: pduData.readUInt32BE(4),
        commandStatus: pduData.readUInt32BE(8),
        sequenceNumber: pduData.readUInt32BE(12),
    };
    const body = pduData.slice(16);
    return { header, body };
}

// Send request to application URL
async function sendToApplication(msisdn, inputs, sessionId) {
    try {
        const response = await axios.get(`${config.applicationUrl+msisdn+'/'+inputs+'/'+sessionId}`);
        return response.data; // Expecting { message: "response text", endSession: true/false }
    } catch (error) {
        logMessage(`Error sending to application: ${error.message}`);
        return { message: 'Error processing request', endSession: false };
    }
}

// Handle PDU
async function handlePdu(connection, pduData) {
    const pdu = parsePdu(pduData);
    const { commandId, sequenceNumber } = pdu.header;

    switch (commandId) {
        case 0x00000009: // bind_transmitter
            const systemId = pdu.body.toString('utf8', 0, 16).replace(/\0/g, '');
            const password = pdu.body.toString('utf8', 16, 25).replace(/\0/g, '');
            if (systemId === 'test' && password === 'test123') {
                connection.socket.write(createBindResponse(sequenceNumber));
                logMessage(`Bound successfully with system_id: ${systemId}`);
            } else {
                logMessage('Bind failed: Invalid credentials');
                connection.state = 'closed';
                connection.socket.end();
            }
            break;

        case 0x00000004: // submit_sm
            const sourceAddr = pdu.body.toString('utf8', 3, 13).replace(/\0/g, ''); // MSISDN
            const shortMessage = pdu.body.toString('utf8', 33).replace(/\0/g, ''); // Inputs
            logMessage(`Received from MSISDN: ${sourceAddr}, Inputs: ${shortMessage}`);

            // Initialize or use existing session_id
            if (!connection.sessionId) {
                connection.sessionId = `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                logMessage(`New session started: ${connection.sessionId}`);
            }

            // Send to application
            const appResponse = await sendToApplication(sourceAddr, shortMessage, connection.sessionId);
            logMessage(`Application response: ${JSON.stringify(appResponse)}`);

            // Process application response
            if (appResponse.endSession) {
                logMessage('Application requested session end, sending unbind');
                connection.socket.write(createUnbind(sequenceNumber));
                connection.waitingForUnbindResponse = true;
            } else {
                connection.socket.write(createDeliverSm(sequenceNumber, appResponse.message));
            }
            break;

        case 0x80000006: // unbind_response
            if (connection.waitingForUnbindResponse) {
                logMessage('Received unbind_response, closing connection');
                connection.state = 'closed';
                connection.socket.end();
            }
            break;

        default:
            logMessage(`Unhandled command_id: 0x${commandId.toString(16).padStart(8, '0')}`);
    }
}

// Server setup
const server = net.createServer((socket) => {
    const connection = new Connection(socket);
    logMessage('New connection accepted');

    socket.on('data', async (data) => {
        connection.buffer = Buffer.concat([connection.buffer, data]);

        while (connection.buffer.length >= 4) {
            const commandLength = connection.buffer.readUInt32BE(0);
            if (connection.buffer.length >= commandLength) {
                const pduData = connection.buffer.slice(0, commandLength);
                connection.buffer = connection.buffer.slice(commandLength);
                await handlePdu(connection, pduData);
            } else {
                break;
            }
        }
    });

    socket.on('end', () => {
        logMessage('Connection closed by client');
        connection.state = 'closed';
    });

    socket.on('error', (err) => {
        logMessage(`Socket error: ${err.message}`);
        connection.state = 'closed';
    });
});

server.listen(config.port, config.host, () => {
    logMessage(`SMPP USSD Server started on port ${config.port}`);
});

server.on('error', (err) => {
    logMessage(`Server error: ${err.message}`);
});