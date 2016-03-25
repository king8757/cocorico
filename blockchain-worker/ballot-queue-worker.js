var config = require('../api/config.json');
var keystone = require('../api/node_modules/keystone');
var async = require('async');

var EthereumAccounts = require('ethereumjs-accounts');
var HookedWeb3Provider = require("hooked-web3-provider");
var Web3 = require('web3');

keystone.init({'mongo' : config.mongo.uri});
keystone.mongoose.connect(config.mongo.uri);
keystone.import('../api/models');

var Ballot = keystone.list('Ballot');

function whenTransactionMined(web3, tx, callback)
{
    async.during(
        function(callback)
        {
            web3.eth.getTransaction(
                tx,
                function(e, r)
                {
                    if (r && r.blockHash)
                        return callback(e, false, r);

                    return callback(e, true, null);
                }
            );
        },
        function(callback)
        {
            setTimeout(callback, 1000);
        },
        function(err, r)
        {
            callback(err, r);
        }
    );
}

function initializeVoterAccount(address, callback)
{
    var web3 = new Web3();
    web3.setProvider(new web3.providers.HttpProvider("http://127.0.0.1:8545"));

    console.log({log:'initialize account ' + address});

    web3.eth.sendTransaction(
        {
            from: web3.eth.accounts[0],
            to: address,
            value: web3.toWei(10, "ether")
        },
        function(error, result)
        {
            whenTransactionMined(
                web3,
                result,
                function(err, block)
                {
                    if (err)
                        return callback(err, null);

                    console.log({
                        address: address,
                        balance: web3.fromWei(web3.eth.getBalance(address), "ether").toString()
                    });

                    return callback(null, block);
                }
            );
        }
    );
}

function getVoteContractInstance(web3, address, callback)
{
    var Vote = require('/opt/cocorico/blockchain/Vote.json');
    var voteContract = web3.eth.contract(eval(Vote.contracts.Vote.abi));
    var voteInstance = voteContract.at(
        address,
        function(err, voteInstance)
        {
            if (err)
                return callback(err, null);

            return callback(null, voteInstance);
        }
    );
}

function waitForBlockchain(callback)
{
    var errorLogged = false;

    var web3 = new Web3();
    web3.setProvider(new web3.providers.HttpProvider("http://127.0.0.1:8545"));

    async.whilst(
        function()
        {
            var connected = web3.isConnected();

            if (!connected && !errorLogged)
                console.log({error : 'unable to connect to the blockchain'});
            if (connected && errorLogged)
                console.log({log : 'successfully connected to the blockchain'});

            return !connected;
        },
        function(callback)
        {
            setTimeout(callback, 5000);
        },
        function(err)
        {
            callback();
        }
    );
}

function handleBallot(ballot, callback)
{
    if (!ballot.id || !ballot.address || !ballot.voteContractAddress
        || !ballot.transaction)
        return callback('invalid ballot', null);

    var web3 = new Web3();
    web3.setProvider(new web3.providers.HttpProvider("http://127.0.0.1:8545"));

    waitForBlockchain(function()
    {
        initializeVoterAccount(
            ballot.address,
            function(err, block)
            {
                if (err)
                    return callback(err, null);

                getVoteContractInstance(
                    web3,
                    ballot.voteContractAddress,
                    function(err, voteInstance)
                    {
                        if (err)
                            return callback(err, null);

                        var hash = '';
                        var ballotEvent = voteInstance.Ballot();
                        ballotEvent.watch(
                            function(err, result)
                            {
                                if (err)
                                    return callback(err, null);

                                if (result.args.user == ballot.address)
                                {
                                    console.log({event:result});

                                    Ballot.model.findById(ballot.id)
                                        .exec(function(err, dbBallot)
                                        {
                                            if (err)
                                                return callback(err, null);

                                            if (!ballot)
                                                return callback('unknown ballot with id ' + ballot.id, null);

                                            dbBallot.transactionHash = hash;
                                            dbBallot.status = 'complete';

                                            dbBallot.save(function(err, dbBallot)
                                            {
                                                return callback(null, dbBallot);
                                            });
                                        });
                                }
                            }
                        );

                        web3.eth.sendRawTransaction(
                            ballot.transaction,
                            function(err, txhash)
                            {
                                if (err)
                                    return callback(err, null);

                                hash = txhash;
                                console.log({transactionHash:txhash});
                            }
                        );
                    }
                )
            }
        );
    });
}

function ballotError(ballot, msg, callback)
{
    console.log({error:msg.toString()});
    Ballot.model.findById(ballot.id)
        .exec(function(err, dbBallot)
        {
            if (err)
                return callback(err, null);

            if (dbBallot)
            {
                dbBallot.status = 'error';
                dbBallot.error = JSON.stringify(msg);

                dbBallot.save(function(err, dbBallot)
                {
                    return callback(null, dbBallot);
                });
            }
            else
                return callback(null, null);
        });
}

require('amqplib/callback_api').connect(
    'amqp://localhost',
    function(err, conn)
    {
        if (err != null)
            return console.error(err);

        conn.createChannel(function(err, ch)
        {
            if (err != null)
                return console.error(err);

            ch.assertQueue('ballots');
            ch.consume(
                'ballots',
                function(msg)
                {
                    if (msg !== null)
                    {
                        var msgObj = JSON.parse(msg.content.toString());

                        // return ch.ack(msg);

                        if (msgObj.ballot)
                        {
                            console.log(msgObj.ballot);
                            handleBallot(msgObj.ballot, function(err, ballot)
                            {
                                if (err)
                                    return ballotError(msgObj.ballot, err, function() {ch.ack(msg)});

                                ch.ack(msg);
                            });
                        }
                    }
                });
        });
    }
);
