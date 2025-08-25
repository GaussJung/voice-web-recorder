## Voice-Web-Recorder v0.93-c 
- simple voice recorder using brower supporting ES6

## Pre-requsite
1) Simple (Local Record + Local Play + Local Download)
- Web Server (Nginx or Apache or Node) or Object Storage (S3 compatible)
- Your own domain and Certification for SSL for recording 
 
2) Advanced (Local Record + Local Play + Upload mp3 + Remote Play )
- Web Server (Nginx or Apache or Node) or Object Storage (S3 compatible) 
- Your own domain and Certification for SSL for recording 
- Basic understanding about S3, Lambda, API-Gateway for MP3 upload 
  
## Setup process 
```bash
# Simple usage 
(at local) 
$ git clone https://github.com/GaussJung/voice-web-recorder 

# Advanced usgae
(at local) 
$ git clone https://github.com/GaussJung/voice-web-recorder
(at aws console) 
$ aws cloudformation ~ 
-- Later -- 
```


