import Foundation
import CoreImage
import AVFoundation
import ImageIO
import UniformTypeIdentifiers

// Orthographic optical study: stationary reeded front surface, flat rear
// surface, moving luminous fields, Snell refraction and Fresnel reflection.
// Art-directed single-bounce approximation, not a full path tracer.
// No source photograph is sampled or deformed by this renderer.
// Rich-light revision: stronger shared illumination; the rib geometry is unchanged.
let root=URL(fileURLWithPath:FileManager.default.currentDirectoryPath)
let folder=root.appendingPathComponent(CommandLine.arguments.dropFirst().first(where: { !$0.hasPrefix("--") }) ?? "artifacts/glass-optical-render")
try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true)
let W=1920,H=1440,fps:Int32=30,seconds=12
let color=CGColorSpace(name:CGColorSpace.sRGB)!
let context=CIContext(options:[.workingColorSpace:color,.outputColorSpace:color])
let rect=CGRect(x:0,y:0,width:W,height:H)
let shader="""
float ellipse(vec2 p,vec2 c,vec2 scale,float angle,float edge) {
 vec2 q=p-c;
 q=vec2(cos(angle)*q.x-sin(angle)*q.y,sin(angle)*q.x+cos(angle)*q.y)/scale;
 return 1.0-smoothstep(1.0-edge,1.0+edge,length(q));
}
vec3 panel(vec2 p,float t) {
 // Three broad light fields move behind the fixed glass. Larger paths and
 // a twelve-second seamless period keep their exchange perceptible on both sides.
 vec2 warm=vec2(.46+.29*sin(t),.31+.20*cos(t+.25));
 vec2 cool=vec2(1.01+.28*cos(t+.65),.55+.25*sin(t+.65));
 vec2 a=(p-warm)/vec2(.60,.53);
 vec2 b=(p-cool)/vec2(.52,.70);
 float peach=exp(-dot(a,a)*1.35);
 float violet=exp(-dot(b,b)*1.25);
 vec3 c=vec3(1.0,.993,.985);
 c=mix(c,vec3(.997,.81,.72),peach*.77);
 c=mix(c,vec3(.755,.705,.9),violet*.80);
 vec2 pearl=vec2(.79+.32*sin(t+2.05),.54+.27*cos(t+2.05));
 vec2 w=(p-pearl)/vec2(.32,.57);
 c=mix(c,vec3(1.0,.997,.992),exp(-dot(w,w)*1.2)*.62);
 // Wide, feathered softboxes: no luminous contour or narrow wriggling line.
 vec2 sweep=p-vec2(.72+.32*sin(t+.45),.48+.15*cos(t+.45));
 float sx=sweep.x*cos(.30)-sweep.y*sin(.30);
 float sheen=exp(-pow(sx/.20,2.0))*exp(-pow(sweep.y/.95,2.0));
 c=mix(c,vec3(1.0,.995,.988),sheen*.57);
 vec2 sweep2=p-vec2(1.02+.30*cos(t+1.8),.37+.19*sin(t+1.8));
 float sx2=sweep2.x*cos(-.28)-sweep2.y*sin(-.28);
 float sheen2=exp(-pow(sx2/.19,2.0))*exp(-pow(sweep2.y/1.0,2.0));
 c=mix(c,vec3(.987,.983,1.0),sheen2*.44);
 return c;
}
vec3 bend(vec3 i,vec3 n,float eta) {
 float ni=dot(n,i);
 float k=1.0-eta*eta*(1.0-ni*ni);
 return eta*i-(eta*ni+sqrt(max(k,0.0)))*n;
}
vec3 studio(vec3 r,float t) {
 vec2 p=r.xy/max(r.z,.06);
 float strip=ellipse(p,vec2(-1.3+.35*sin(t),.2),vec2(.55,2.6),-.04,.6);
 float fill=ellipse(p,vec2(1.1+.2*cos(t+.8),-.7),vec2(.85,2.5),.18,.7);
 return vec3(.86,.85,.88)+vec3(1.2)*strip+vec3(.55)*fill;
}
vec3 trace(vec2 p,float t,float strength) {
 float u=p.x/1.3333333;
 float ribs=u*65.0+.42*sin(u*19.0)+.20*sin(u*61.0)+.045*sin(p.y*3.0+u*7.0);
 float phase=ribs*6.28318530718;
 float q=(fract(ribs)-.5)*1.94;
 float slope=q/sqrt(max(.08,1.0-q*q));
 vec3 n=normalize(vec3(-slope,.008*sin(p.y*5.0+u*7.0),1.0));
 vec3 i=vec3(0.0,0.0,-1.0);
 vec3 inside=bend(i,n,1.0/1.48);
 vec3 outside=bend(inside,vec3(0.0,0.0,1.0),1.48);
 vec2 rear=p+inside.xy*(.012/-inside.z);
 vec2 hit=rear+outside.xy*(.24/-outside.z);
 // A small angular spread approximates the fine surface roughness.
 vec3 transmitted=panel(hit,t)*.6+panel(hit+vec2(.003,.002),t)*.2+panel(hit-vec2(.003,.002),t)*.2;
 float fresnel=.0375+.9625*pow(1.0-n.z,5.0);
 vec3 reflected=studio(i-2.0*dot(n,i)*n,t);
 vec3 c=mix(transmitted,reflected,fresnel);
 return clamp(c,0.0,1.0);
}
kernel vec4 glass(float W,float H,float t,float strength,float mode) {
 vec2 p=destCoord()/H;
 if(mode>0.5)return vec4(panel(p,t),1.0);
 vec3 c=trace(p,t,strength);
 return vec4(c,1.0);
}
"""
guard let kernel=CIColorKernel(source:shader) else{fatalError("Shader compile failed")}
func frame(_ t:Double,_ strength:Float=1.0,_ mode:Float=0)->CIImage{
 kernel.apply(extent:rect,arguments:[Float(W),Float(H),Float(t),strength,mode])!
}
for i in 0..<4{
 let t=Double(i)*Double.pi/2
 try context.writePNGRepresentation(of:frame(t),to:folder.appendingPathComponent("phase-\(i).png"),format:.RGBA8,colorSpace:color)
 try context.writePNGRepresentation(of:frame(t,1,1),to:folder.appendingPathComponent("source-\(i).png"),format:.RGBA8,colorSpace:color)
}
if CommandLine.arguments.contains("--stills"){print("Saved scene and light-source phases");exit(0)}
let writer=try AVAssetWriter(outputURL:folder.appendingPathComponent("optical-glass.mp4"),fileType:.mp4)
writer.shouldOptimizeForNetworkUse=true
let track=AVAssetWriterInput(mediaType:.video,outputSettings:[AVVideoCodecKey:AVVideoCodecType.h264,AVVideoWidthKey:W,AVVideoHeightKey:H,AVVideoCompressionPropertiesKey:[AVVideoAverageBitRateKey:7000000,AVVideoExpectedSourceFrameRateKey:fps,AVVideoMaxKeyFrameIntervalKey:60,AVVideoProfileLevelKey:AVVideoProfileLevelH264HighAutoLevel]])
let adapter=AVAssetWriterInputPixelBufferAdaptor(assetWriterInput:track,sourcePixelBufferAttributes:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA,kCVPixelBufferWidthKey as String:W,kCVPixelBufferHeightKey as String:H,kCVPixelBufferIOSurfacePropertiesKey as String:[:]])
writer.add(track);guard writer.startWriting() else{fatalError("Video start failed")};writer.startSession(atSourceTime:.zero)
let gif=CGImageDestinationCreateWithURL(folder.appendingPathComponent("optical-glass.gif") as CFURL,UTType.gif.identifier as CFString,seconds*15,nil)!
CGImageDestinationSetProperties(gif,[kCGImagePropertyGIFDictionary:[kCGImagePropertyGIFLoopCount:0]] as CFDictionary)
for i in 0..<(seconds*Int(fps)){
 while !track.isReadyForMoreMediaData{if writer.status == .failed{fatalError(writer.error!.localizedDescription)};Thread.sleep(forTimeInterval:0.003)}
 autoreleasepool{
  let picture=frame(2*Double.pi*Double(i)/Double(seconds*Int(fps)))
  var buffer:CVPixelBuffer?;CVPixelBufferPoolCreatePixelBuffer(nil,adapter.pixelBufferPool!,&buffer)
  context.render(picture,to:buffer!,bounds:rect,colorSpace:color)
  guard adapter.append(buffer!,withPresentationTime:CMTime(value:Int64(i),timescale:fps)) else{fatalError("Video frame failed")}
  if i%2==0{
   let small=picture.transformed(by:CGAffineTransform(scaleX:0.375,y:0.375))
   let cg=context.createCGImage(small,from:CGRect(x:0,y:0,width:720,height:540),format:.RGBA8,colorSpace:color)!
   CGImageDestinationAddImage(gif,cg,[kCGImagePropertyGIFDictionary:[kCGImagePropertyGIFDelayTime:2.0/30.0,kCGImagePropertyGIFUnclampedDelayTime:2.0/30.0]] as CFDictionary)
  }
 }
 if i%120==0{print("Rendered \(i)/\(seconds*Int(fps))");fflush(stdout)}
}
track.markAsFinished();let done=DispatchSemaphore(value:0);writer.finishWriting{done.signal()};done.wait()
guard writer.status == .completed,CGImageDestinationFinalize(gif) else{fatalError("Export failed")}
print("Optical animation exported")
