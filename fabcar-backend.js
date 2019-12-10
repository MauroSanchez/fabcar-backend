const express = require('express')
const http = require('http')
const socketIO = require('socket.io')

const Fabric_Client = require('fabric-client');
const path = require('path');
const util = require('util');
const os = require('os');

// Configura la red fabric.
const fabric_client = new Fabric_Client();
const channel = fabric_client.newChannel('mychannel');
const peer = fabric_client.newPeer('grpc://localhost:7051');
channel.addPeer(peer);
const order = fabric_client.newOrderer('grpc://localhost:7050')
channel.addOrderer(order);
const store_path = path.join(__dirname, 'hfc-key-store');

// Express
const port = 4001
const app = express()
const server = http.createServer(app)
const io = socketIO(server)

// Este método verifica si el auto dado existe y ejecuta la devolución de llamada dependiendo del éxito / fracaso
async function carExists(carID, success, failure){
    channel.queryByChaincode({
            chaincodeId: 'fabcar',
            fcn: 'queryCar',
            args: [carID]
    }).then( query_responses => {
        if (query_responses && query_responses.length == 1) {
            if (query_responses[0] instanceof Error) {
                failure()
            } else if (query_responses.toString().length > 0) {
                success()
            } else {
                failure()
            }
        } else {
            failure()
        }   
    });
}

// Este método consulta al peer para recuperar la información como se define en el argumento de solicitud
async function query(request, socket){
    // envía una propuesta a uno o más peers de respaldo que serán manejados por el chaincode
    query_responses = await channel.queryByChaincode(request);
    socket.emit('RESPONSE', {type: 'FEED', payload: "Sending query to peers" });
    if (query_responses && query_responses.length == 1) {
        if (query_responses[0] instanceof Error) {
            resp = "error from query = ", query_responses[0];
            console.error("error from query = ", query_responses[0]);
            socket.emit('RESPONSE' , {type: 'ERROR' , payload: resp});
        } else {
            data =  JSON.parse(query_responses[0]);
            socket.emit('RESPONSE', {type: 'END', payload: "Data retrieved" });
            if (!data.length) {
                 // datos adicionales para la respuesta para la consulta individual
                data = [{Key: request.args[0], 'Record': data}]  
            } 
            console.log(`query completed, data: ${data}`)
            socket.emit('RESPONSE', {type: 'INFO', payload: data });
        }
    } else {
        // Si no se devuelve respuesta éxitosa
        console.log("No payloads were returned from query");
        socket.emit('RESPONSE', {type: 'ERROR', payload: "No payloads were returned from query" });
    }    
}

// Este método invoca chaincode en el peer utilizando los datos especificados en el argumento de solicitud
async function invoke(request, socket){
    let tx_id = null;
    const args = {...request.args}

    // obtener un objeto de ID de transacción basado en el usuario actual asignado al cliente de fabric
    tx_id = fabric_client.newTransactionID();
    console.log("Assigning transaction_id: ", tx_id._transaction_id);
    socket.emit('RESPONSE',{type: 'FEED' , payload: `Assigning transaction_id: ${tx_id._transaction_id}`})

    // agregue tx id para solicitar
    var request = {
        ...request,
        txId: tx_id
    };
    socket.emit('RESPONSE',{type: 'FEED' , payload: `Creating request to be sent`})

    // envía la propuesta de transacción a los peers
    const results = await channel.sendTransactionProposal(request);
    socket.emit('RESPONSE',{type: 'FEED' , payload: `Sending transaction proposal to peers`})

    const proposalResponses = results[0];
    const proposal = results[1];
    let isProposalGood = false;

    if (proposalResponses && proposalResponses[0].response &&
        proposalResponses[0].response.status === 200) {
            isProposalGood = true;
            socket.emit('RESPONSE',{type: 'FEED' , payload: `Transaction proposal was good`})
            console.log('Transaction proposal was good');
        } else {
            socket.emit('RESPONSE',{type: 'ERROR' , payload: `Transaction proposal was bad`})
            console.error('Transaction proposal was bad');
        }
    if (isProposalGood) {
        const msg = (util.format(
            'Successfully sent Proposal and received ProposalResponse: Status - %s, message - "%s"',
            proposalResponses[0].response.status, proposalResponses[0].response.message));

        socket.emit('RESPONSE',{type: 'FEED' , payload: msg})
        console.error(msg);

        // crea la solicitud para que el ordenante confirme la transacción
        socket.emit('RESPONSE',{type: 'FEED' , payload: `Building up request for orderer to have the transaction committed`})
        var request = {
            proposalResponses: proposalResponses,
            proposal: proposal
        };

        // establece el escucha de transacciones y establece un tiempo de espera de 30 segundos
        // si la transacción no se confirmó dentro del período de tiempo de espera,
        // informa un estado de TIMEOUT
        var transaction_id_string = tx_id.getTransactionID(); // Obtenga la cadena de ID de transacción que utilizará el procesamiento de eventos

        var promises = [];

        var sendPromise = channel.sendTransaction(request);
        promises.push(sendPromise); // queremos primero la transacción de envío, para que sepamos dónde verificar el estado

        socket.emit('RESPONSE',{type: 'FEED' , payload: `Sending transaction`})

        // obtener un eventhub una vez que el cliente de Fabric tiene un usuario asignado. El usuario
        // es obligatorio porque el registro del evento debe estar firmado
        //socket.emit('transferResponse',{type: 'feed' , payload: 'Setting up event hub'})
        let event_hub = fabric_client.newEventHub();
        event_hub.setPeerAddr('grpc://localhost:7053');
        socket.emit('RESPONSE',{type: 'FEED' , payload: `Setting up event hub`})

        // usando resolver la promesa para que se pueda procesar el estado del resultado
        // bajo la cláusula then en lugar de tener el proceso de cláusula catch
        // El estado
        socket.emit('RESPONSE',{type: 'FEED' , payload: `Creating new transaction promise`})
        let txPromise = new Promise((resolve, reject) => {
            let handle = setTimeout(() => {
                event_hub.disconnect();
                resolve({event_status : 'TIMEOUT'}); //podríamos usar reject(new Error('Trnasaction did not complete within 30 seconds'));
            }, 3000);
            socket.emit('RESPONSE',{type: 'FEED' , payload: `Connecting to event hub`})
            event_hub.connect();
            event_hub.registerTxEvent(transaction_id_string, (tx, code) => {
                // esta es la devolución de llamada para el estado del evento de transacción
                // primero un poco de limpieza del oyente de eventos
                clearTimeout(handle);
                event_hub.unregisterTxEvent(transaction_id_string);
                event_hub.disconnect();

                // ahora deja que la aplicación sepa lo que pasó
                var return_status = {event_status : code, tx_id : transaction_id_string};
                socket.emit('RESPONSE',{type: 'FEED' , payload: `TRANSACTION IS ${tx}`})
                console.log("TRANSACTION IS" ,tx);
                if (code !== 'VALID') {
                    console.error('The transaction was invalid, code = ' + code);
                    socket.emit('RESPONSE',{type: 'ERROR' , payload: `The transaction was invalid, code = ${code}`})
                    resolve(return_status); 
                } else {
                    console.log('The transaction has been committed on peer ' + event_hub._ep._endpoint.addr);
                    socket.emit('RESPONSE',{type: 'FEED' , payload: `The transaction has been committed on peer ${event_hub._ep._endpoint.addr}`})
                    resolve(return_status);
                }
            }, (err) => {
                // esta es la devolución de llamada si algo sale mal con el registro o procesamiento del evento
                reject(new Error('There was a problem with the eventhub ::'+err));
            });
        });

        promises.push(txPromise);

    } else {
        socket.emit('RESPONSE',{type: 'ERROR' , payload: `Failed to send Proposal or receive valid response. Response null or status is not 200. exiting...`})
        console.error('Failed to send Proposal or receive valid response. Response null or status is not 200. exiting...');
        throw new Error('Failed to send Proposal or receive valid response. Response null or status is not 200. exiting...');
    }

    Promise.all(promises).then((results) => {
        console.log('Send transaction promise and event listener promise have completed');
        socket.emit('RESPONSE',{type: 'FEED' , payload: `Send transaction promise and event listener promise have completed`})

        // verifique los resultados en el orden en que se agregaron las promesas a la lista de todas
        socket.emit('RESPONSE',{type: 'FEED' , payload: `Checking results`})
        if (results && results[0] && results[0].status === 'SUCCESS') {
            console.log('Successfully sent transaction to the orderer.');
            socket.emit('RESPONSE',{type: 'FEED' , payload: `Successfully sent transaction to the orderer`})
        } else {
            console.error('Failed to order the transaction. Error code: ' + response.status);
            socket.emit('RESPONSE',{type: 'ERROR' , payload: `Failed to order the transaction. Error code: ${cresponse.statusode}`})
        }

        if(results && results[1] && results[1].event_status === 'VALID') {
            console.log('Successfully committed the change to the ledger by the peer');
            socket.emit('RESPONSE',{type: 'END' , payload: `Successfully committed the change to the ledger by the peer`})
            if (Object.keys(args).length === 2) {
                socket.emit('RESPONSE',{type: 'INFO' , payload:[{Key:`${args[0]} successfully transferred to ${args[1]}!` ,Msg:'Successfully committed transfer to the ledger'}] })
            } else {
                socket.emit('RESPONSE',{type: 'INFO' , payload:[{Key:`Successfully created ${args[0]}!` ,Msg:'Successfully committed transfer to the ledger'}] })
            }
        } else {
            console.log('Transaction failed to be committed to the ledger due to ::'+results[1].event_status);
            socket.emit('RESPONSE',{type: 'ERROR' , payload: `Transaction failed to be committed to the ledger due to :: ${results[1].event_status}`})
        }
    }).catch((err) => {
        console.error('Failed to invoke successfully :: ' + err);
        socket.emit('RESPONSE',{type: 'ERROR' , payload: `Failed to invoke successfully :: ${err}`})
    });
}

// Este método toma el socket (para responder al cliente) y el nombre del usuario que se va a inscribir. Devuelve al usuario si tiene éxito
// El usuario predeterminado es 'usuario1' ya que no hay otros usuarios inscritos.
async function getUser(socket, user) {

    // obtiene una instancia de la clase KeyValueStore
    const state_store = await Fabric_Client.newDefaultKeyValueStore({ path: store_path})
    socket.emit('RESPONSE' , {type: 'FEED' , payload: "Getting key-value store from local server storage"});

    // asigna la tienda al cliente de fabric
    fabric_client.setStateStore(state_store);
    socket.emit('RESPONSE' , {type: 'FEED' , payload: "Assigning store to the fabric client"});

    // Este es un método de fábrica. Devuelve una nueva instancia de la implementación de la API CryptoSuite
    const crypto_suite = Fabric_Client.newCryptoSuite();
    socket.emit('RESPONSE' , {type: 'FEED' , payload: "Creating new crypto suite"});

    // usa la misma ubicación para la tienda estatal (donde se guarda el certificado de usuario)
    // y la tienda de cifrado (donde se guardan las claves de los usuarios)
    const crypto_store = Fabric_Client.newCryptoKeyStore({path: store_path});
    crypto_suite.setCryptoKeyStore(crypto_store);
    fabric_client.setCryptoSuite(crypto_suite);
    socket.emit('RESPONSE' , {type: 'FEED' , payload: "Setting up crypto suite"});

    // obtener el usuario inscrito de la persistencia, este usuario firmará todas las solicitudes
    const user_from_store = await fabric_client.getUserContext(user, true);
    if (user_from_store && user_from_store.isEnrolled()) {
        
        console.log(`Successfully loaded ${user} from persistence`);
        socket.emit('RESPONSE', {type: 'END',  payload: `Successfully loaded ${user} from persistence` });

        const eh = channel.newChannelEventHub(peer)
        eh.connect()
        eh.registerBlockEvent(
            (block) => {
                console.log(`Lastest block number: ${block.number}`)
                socket.emit('BLOCKUDPATE', block);
                eh.unregisterBlockEvent(block.number)
                }, (err) => {console.log('Block updater error',err);} 
        );  
        
        return user_from_store;

    } else {
        socket.emit('RESPONSE', {type: 'ERROR',  payload: `Failed to get ${user}.... run registerUser.js` });
        throw new Error(`Failed to get ${user}.... run registerUser.js`);
    }
}

io.on('connection', socket => {

    console.log(`Connected to client with socket ID ${socket.id}`)
    socket.emit('RESPONSE', {type: 'FEED',  payload: `Connected to server with socket ID ${socket.id}` });

    // inscribe al usuario cuando el cliente se conecta, el usuario predeterminado es user1
    let user = getUser(socket, 'user1');    

    socket.on('REQUEST', (req) => {
        switch (req.action)
        {
            case "QUERY":
                socket.emit('RESPONSE', {type: 'START', payload: `Request for QUERY for ${req.data.ID} received` });
                carExists(req.data.ID, 
                            () =>  {query({
                                    chaincodeId: 'fabcar',
                                    fcn: 'queryCar',
                                    args: [req.data.ID]
                                    }
                                , socket)},
                            () => {
                                socket.emit('RESPONSE', {type: 'ERROR', payload: `${req.data.ID} DOES NOT EXIST!` });
                            });        
                break;

            case "QUERYALL":
                socket.emit('RESPONSE', {type: 'START', payload: `Request for QUERY All received` });
                query(
                        {
                            chaincodeId: 'fabcar',
                            fcn: 'queryAllCars',
                            args: []
                        }
                    , socket);
                    break;
            case "TRANSFER":
                socket.emit('RESPONSE', {type: 'START', payload: `Request for TRANSFER for ${req.data.ID} to ${req.data.newOwner} received` });
                carExists(req.data.ID, 
                            () => {invoke(
                                {
                                    chaincodeId: 'fabcar',
                                    fcn: 'changeCarOwner',
                                    args: [req.data.ID , req.data.newOwner],
                                    chainId: 'mychannel'
                                }
                            , socket)},
                            () => {
                                socket.emit('RESPONSE', {type: 'ERROR', payload: `${req.data.ID} DOES NOT EXIST!` });
                            });
                    break;
            case "CREATE":
                socket.emit('RESPONSE', {type: 'START', payload: `Request for CREATE for ${req.data.ID} received` });
                carExists(req.data.ID, 
                    () => {
                        socket.emit('RESPONSE', {type: 'ERROR', payload: `${req.data.ID} ALREADY EXISTS!` });
                    },
                    () => {invoke(
                        {
                            chaincodeId: 'fabcar',
                            fcn: 'createCar',
                            args: [req.data.ID, req.data.make, req.data.model, req.data.color, req.data.owner],
                            chainId: 'mychannel',
                        }
                    , socket)});
                    break;
        }
    })

    socket.on('disconnect', () => {
        console.log(`Disconnected to client ${socket.id}`)
    })
})

server.listen(port, () => console.log(`Listening on port ${port}`))