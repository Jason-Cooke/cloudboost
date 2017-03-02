
/*
#     CloudBoost - Core Engine that powers Bakend as a Service
#     (c) 2014 HackerBay, Inc. 
#     CloudBoost may be freely distributed under the Apache 2 License
*/



var q = require("q");
var util = require("../../helpers/util.js");
var _ = require('underscore');

module.exports = function() {

    //Update Settings for the App
    global.app.put('/settings/:appId/:category',function(req,res){

        console.log('++++++++ General App Settings API +++++++++');

        var appId = req.params.appId;
        var category = req.params.category;
        var sdk = req.body.sdk || "REST";
        var settings = req.body.settings || {};
        var appKey = req.body.key || req.params.key;

        if(typeof settings=="string"){
            settings=JSON.parse(settings);
        }

        global.appService.isMasterKey(appId, appKey).then(function (isMasterKey) {
            if(isMasterKey){
                
                if(global.mongoDisconnected){
                    return res.status(500).send('Storage / Cache Backend are temporarily down.');
                }
                
                global.appService.updateSettings(appId,category,settings).then(function(settings){
                    return res.status(200).send(settings);
                },function(err){
                    return res.status(500).send('Error');
                });
                
            }else{
                return res.status(401).send({status : 'Unauthorized'});
            }
        }, function(error){
            return res.status(500).send('Cannot retrieve security keys.');
        });

        global.apiTracker.log(appId,"App / Settings", req.url,sdk);

    });
    
    //Get Settings for the App
    global.app.post('/settings/:appId',function(req,res){

        console.log('++++++++ General App Settings API +++++++++');       

        var appId = req.params.appId;
        var sdk = req.body.sdk || "REST";
        var appKey = req.body.key || req.params.key;

        global.appService.isMasterKey(appId, appKey).then(function (isMasterKey) {
            if(isMasterKey){

                if(global.mongoDisconnected){
                    return res.status(500).send('Storage / Cache Backend are temporarily down.');
                }

                global.appService.getAllSettings(appId).then(function(settings){
                    return res.status(200).send(settings);
                },function(err){
                    return res.status(500).send('Error');
                });
                
            }else{
                return res.status(401).send({status : 'Unauthorized'});
            }
        }, function(error){
            return res.status(500).send('Cannot retrieve security keys.');
        });

        global.apiTracker.log(appId,"App / Settings", req.url,sdk);

    });

    
    /*stream file settings file to gridfs
        1.Get fileStream from request
        2.Check if masterKey is false
        3.GetAppSettings and delete previous file if exists(in background)
        4.Get ServerUrl to make fileUri
        5.Save current file to gridfs
    */
    global.app.put('/settings/:appId/file/:category', function (req, res) {

        console.log("++++ Stream file to gridfs ++++++");

        var appId = req.params.appId;
        var appKey = req.body.key || req.params.key; 
        var category = req.params.category;       
        
        var thisUri=null;
        var promises=[];        

        promises.push(_getFileStream(req));
        promises.push(global.appService.isMasterKey(appId, appKey));
        promises.push(global.appService.getAllSettings(appId));
        promises.push(global.keyService.getMyUrl());

        q.all(promises).then(function(resultList){

            //Check database connectivity
            if(global.mongoDisconnected){
                return res.status(500).send('Storage / Cache Backend are temporarily down.');
            }
            //Check if masterKey is false
            if(!resultList[1]){
                return res.status(401).send({status : 'Unauthorized'});
            }
            //Delete previous file from gridfs
            if(resultList[2] && resultList[2].length>0){
                var categorySettings=_.where(resultList[2], {category: category});               
                
                if(categorySettings && categorySettings.length>0){

                    var fileName=null;
                    if(category=="general"){
                        if(categorySettings[0].settings.appIcon){
                            //get the filename from fileUri
                            fileName=categorySettings[0].settings.appIcon.split("/").reverse()[0];                            
                        }
                    }

                    if(category=="push"){
                        if(categorySettings[0].settings.apple.certificates.length>0){
                            //get the filename from fileUri
                            fileName=categorySettings[0].settings.apple.certificates[0].split("/").reverse()[0];                            
                        }
                    } 

                    //Delete from gridFs
                    if(fileName){
                        global.mongoService.document.deleteFileFromGridFs(appId,fileName); 
                    }                              

                }
                
            }

            //Server URI
            thisUri=resultList[3];

            var fileName=util.getId();
            if(category=="general"){
                fileName=appId;
            }    
            return global.mongoService.document.saveFileStream(appId,resultList[0].fileStream,fileName,resultList[0].contentType);            
        
        }).then(function(savedFile){
            var fileUri=null;

            fileUri=thisUri+'/settings/'+appId+'/file/'+savedFile.filename;
            if(category=="general"){
                fileUri=thisUri+'/appfile/'+appId+'/icon';
            }    
            
            return res.status(200).send(fileUri);
        },function(error){
            return res.status(500).send(error);
        });        

    });

    //get file from gridfs
    global.app.get('/settings/:appId/file/:fileName', function (req, res) {

        console.log("++++ Stream file from gridfs++++++");

        var appId = req.params.appId;
        var fileName = req.params.fileName;
        var appKey = req.query.key || req.body.key || req.params.key;         

        if(!appKey){
            return res.status(500).send("Unauthorized");
        }

        global.appService.isMasterKey(appId, appKey).then(function(masterKey){

            if(!masterKey){
                var unathorizedPromise = global.q.defer();
                unathorizedPromise.reject("Unauthorized.");
                return unathorizedPromise.promise;
            }else{
                return global.mongoService.document.getFile(appId,fileName.split('.')[0]);
            }


        }).then(function(file){

            var fileStream=global.mongoService.document.getFileStreamById(appId,file._id);

            res.set('Content-Type', file.contentType);
            res.set('Content-Disposition', 'attachment; filename="' + file.filename + '"');            

            fileStream.on("error", function(err) {                  
              res.send(500, "Got error while processing stream " + err.message);
              res.end();
            });           
            
            fileStream.on('end', function() {
                res.end();        
            });

            fileStream.pipe(res);

        },function(error){
            return res.status(500).send(error);
        });                 

    });
};    

/*Desc   : Get fileStream and contentType from upload request
  Params : req
  Returns: Promise
           Resolve->JSON{filestream,contentType} 
           Reject->
*/
function _getFileStream(req){

    var deferred = q.defer();

    var resObj={      
        fileStream:null,       
        contentType:null
    };

    //Create a FileStream(add data)
    var Readable = require('stream').Readable;
    var readableStream = new Readable;             

    if (req.body.data) {        
        
        readableStream.push(req.body.data);// the string you want
        readableStream.push(null); 
        
        //Setting response
        resObj.fileStream=readableStream;
        resObj.contentType="text/plain";
        resObj.fileObj=req.body.fileObj; 

        deferred.resolve(resObj);       
    } else if (req.files.file) {              

        readableStream.push(req.files.file.data);
        readableStream.push(null);

        //Setting response
        resObj.fileStream=readableStream;
        resObj.contentType=req.files.file.mimetype;
        if (req.body.fileObj) {
            resObj.fileObj=JSON.parse(req.body.fileObj);
        }
         
        deferred.resolve(resObj);      
    } else {              

        readableStream.push(req.files.fileToUpload.data);
        readableStream.push(null);

        //Setting response
        resObj.fileStream=readableStream;
        resObj.contentType=req.files.file.mimetype;
            
        deferred.resolve(resObj);      
    }    

    //Setting response
    resObj.fileStream=readableStream;
    resObj.contentType=req.files.file.mimetype;    
     
    deferred.resolve(resObj);      

   return deferred.promise;
}