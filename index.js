const cluster = require('cluster');
const numCPUs = require('os').cpus().length;
const fs = require('fs');
const http = require('http');
const tls = require('tls');
const spawn = require('child_process').spawn;
const binding = process.binding('http_parser');
const HTTPParser = binding.HTTPParser;
const methods = binding.methods;
const url = require('url');
const net = require('net');
const MongoClient = require('mongodb').MongoClient;
const ObjectId = require('mongodb').ObjectID;

const mongoUrl = 'mongodb://127.0.0.1:3001';


const dbName = 'meteor';
const maxBodySize = 2000000;
const certs = {};
fs.readdirSync('certs/').forEach(file => {
    certs[file.substring(0, file.length - 4)] = fs.readFileSync('certs/' + file)
});

let db;
let collection;


//const kOnHeaders = HTTPParser.kOnHeaders | 0;
const kOnHeadersComplete = HTTPParser.kOnHeadersComplete | 0;
const kOnBody = HTTPParser.kOnBody | 0;
const kOnMessageComplete = HTTPParser.kOnMessageComplete | 0;
//const kOnExecute = HTTPParser.kOnExecute | 0;




const httpAddress = 7783;

const key = fs.readFileSync('cert.key');
const cert = fs.readFileSync('certs/yngwie.ru.crt');

class HTTPServerAsyncResource {
    constructor(type, socket) {
        this.type = type;
        this.socket = socket;
    }
}

function createSecureContext(cert) {
    return tls.createSecureContext({
        key: key,
        cert: cert
    })
}

function generateCert(servername, cb) {
    console.log(`gen cert ${servername}`);
    let gen_cert = spawn('./gen_cert.sh', [servername, Math.floor(Math.random() * 1000000000000)]);

    gen_cert.stdout.once('data', (data) => {
        certs[servername] = data;
        let ctx = createSecureContext(data);
        cb(null, ctx);
        fs.writeFile(`certs/${servername}.crt`, data, (err) => {
            if (err) {
                console.log(err.message)
            }
        })
    });

    gen_cert.stderr.on('data', (data) => {
        console.log(`cert gen stderr: ${data}`)
    })
}

function SNICallback(servername, cb) {
    //console.log(`snicallback ${servername}`)
    if (servername in certs) {
        console.log(`using existing cert ${servername}`);
        let ctx = createSecureContext(certs[servername]);
        cb(null, ctx)
    } else {
        generateCert(servername, cb)
    }
}

function createRequestParser(socket, requestsStore, host, port, ssl) {
    const requestParser = new HTTPParser()//HTTPParser.REQUEST);
    requestParser.initialize(HTTPParser.REQUEST, new HTTPServerAsyncResource('HTTPINCOMINGMESSAGE', socket));


    requestParser[kOnMessageComplete] = function () {
        const req = requestsStore[requestsStore.length - 1];
        req.request = req.request + req.request_body.slice(0, maxBodySize).toString();
        req.request_time = new Date();
        delete req.request_body;
        console.log('requestParser kOnMessageComplete')
    };

    requestParser[kOnHeadersComplete] = function (versionMajor, versionMinor, headers, method,
        url, statusCode, statusMessage, upgrade, shouldKeepAlive) {
        let h = '';
        for (var i = 0; i < headers.length / 2; ++i) {
            h += `${headers[i * 2]}: ${headers[i * 2 + 1]}\r\n`;
        }
        const r = `${methods[method]} ${url} HTTP/${versionMajor}.${versionMinor}\r\n${h}\r\n`
        const req = {
            _id: (new ObjectId()).toString(),
            host: host,
            port: port,
            ssl: ssl,
            request: r,
            request_body: Buffer.from('')
        };
        requestsStore.push(req)
    };

    requestParser[kOnBody] = function (b, start, len) {
        const req = requestsStore[requestsStore.length - 1];
        req.request_body = Buffer.concat([req.request_body, b.slice(start, start + len)])
    };

    return requestParser;
}

function createResponseParser(socket, requestsStore) {
    const responseParser = new HTTPParser()//HTTPParser.RESPONSE);    
    responseParser.initialize(HTTPParser.RESPONSE, new HTTPServerAsyncResource('HTTPINCOMINGMESSAGE', socket));
    

    responseParser[kOnMessageComplete] = () => {
        console.log('responseParser kOnMessageComplete');
        const req = requestsStore.shift();
        if (req && req.response && req.response_body) {
            req.response += req.response_body.slice(0, maxBodySize).toString();
            req.response_time = new Date();
            req.time = req.response_time - req.request_time;
            delete req.response_body;
            //console.log(req);
            collection.insertOne(req)
        }
    };

    responseParser[kOnHeadersComplete] = function (versionMajor, versionMinor, headers, method,
        url, statusCode, statusMessage, upgrade, shouldKeepAlive) {
        let h = '';
        for (var i = 0; i < headers.length / 2; ++i) {
            h += `${headers[i * 2]}: ${headers[i * 2+ 1]}\r\n`;
        }
        const resp = `HTTP/${versionMajor}.${versionMinor} ${statusCode} ${statusMessage}\r\n${h}\r\n`;
        for (var i = 0; i < requestsStore.length; ++i) {
            if (!requestsStore[i].response) {
                requestsStore[i].response = resp;
                requestsStore[i].response_body = Buffer.from('');
                break
            }
        }
    };

    responseParser[kOnBody] = function (b, start, len) {
        for (let i = requestsStore.length - 1; i >= 0; --i) {
            if (requestsStore[i].response_body) {
                requestsStore[i].response_body = Buffer.concat([requestsStore[i].response_body, b.slice(start, start + len)]);
                break
            }
        }

    };

    return responseParser
}

function httpConnection(req, res) {
    if (req.url.startsWith('http')) {
        try {
            const parsedUrl = url.parse(req.url);
            const options = {
                host: parsedUrl.hostname,
                port: parsedUrl.port || 80
            };
            const proxyReq = net.connect(options, () => {
                const requestsStore = [];

                const requestParser = createRequestParser(req.socket, requestsStore, options.host, options.port, false);
                const responseParser = createResponseParser(proxyReq, requestsStore);

                req.socket.on('data', (chunk) => {
                    requestParser.execute(chunk)
                });
                req.socket.on('end', () => {
                    requestParser.finish()
                });
                proxyReq.on('data', (chunk) => {
                    responseParser.execute(chunk)
                });
                proxyReq.on('end', () => {
                    responseParser.finish()
                });

                
                let h = '';
                for (let i = 0; i < req.rawHeaders.length / 2; ++i) {
                    if (req.rawHeaders[i * 2] === 'Proxy-Connection') {
                        continue
                    }
                    h += `${req.rawHeaders[i * 2]}: ${req.rawHeaders[i * 2 + 1]}\r\n`;
                }
                let p = Buffer.from(`${req.method} ${parsedUrl.path} HTTP/1.1\r\n${h}\r\n`)
                proxyReq.write(p);
                requestParser.execute(p);
                req.socket.pipe(proxyReq).pipe(req.socket);

                               
            });
            proxyReq.on('error', (e) => {
                console.log(`proxyReq error ${e}`)
            })

        } catch (e) {
            console.log(`Unable to parse ${req.url}`)
        }
    }
}

if (cluster.isMaster) {
    console.log(`Master ${process.pid} is running`);

    // Fork workers.
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork()
    }

    cluster.on('exit', (worker) => {
        console.log(`worker ${worker.process.pid} died`);
    });
} else {

    const httpServer = http.createServer(httpConnection);

    httpServer.on('error', () => {
        console.log('httpServer error')
    });

    httpServer.on('connect', (req, cltSocket, head) => {
        console.log(`connect ${req.url}`);
        cltSocket.on('error', (e) => {
            console.log(`cltSocket error ${e}`)
        });
        const u = req.url.split(':');
        const options = {
            rejectUnauthorized: false
        };
        if (u.length === 2) {
            options.host = u[0];
            options.port = u[1]
        } else {
            options.host = req.url;
            options.port = 443
        }
        const proxyReq = tls.connect(options, () => {
            cltSocket.write('HTTP/1.1 200 Connection Established\r\n' +
                'Proxy-agent: Node.js-Proxy\r\n' +
                '\r\n');

            const requestsStore = [];

            

            const tlsOptions = {
                key: key,
                cert: cert,
                SNICallback: SNICallback,
                isServer: true
            };
            const tlsSocket = new tls.TLSSocket(cltSocket, tlsOptions);
            const requestParser = createRequestParser(tlsSocket, requestsStore, options.host, options.port, true);
            const responseParser = createResponseParser(proxyReq, requestsStore);

            tlsSocket.pipe(proxyReq).pipe(tlsSocket);

            tlsSocket.on('data', (chunk) => {
                requestParser.execute(chunk)
            });
            tlsSocket.on('end', () => {
                requestParser.finish()
            });
            proxyReq.on('data', (chunk) => {
                responseParser.execute(chunk)
            });
            proxyReq.on('end', () => {
                responseParser.finish()
            });
        });

        proxyReq.on('error', (e) => {
            console.log(`proxyReq error ${e}`)
        })
    });


    MongoClient.connect(mongoUrl, { useNewUrlParser: true }, (err, client) => {
        if (err) {
            console.log(`Unable to connect ${err}`);
            return
        }
        console.log("Connected successfully to server");

        db = client.db(dbName);
        collection = db.collection('proxy');
        httpServer.listen(httpAddress, 8192)
    })
}
