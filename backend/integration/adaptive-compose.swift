import Foundation
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers
import Vision
import CoreVideo

struct Layer: Codable { var text:String; var box:[Double]; var fontSize:Double; var fontWeight:Int; var align:String; var color:String? }
struct Card: Codable { let box:[Double]; let color:String; let ink:String; let icon:String; let index:Int }
struct Spec: Codable { let mode:String; let width:Int; let height:Int; let layers:[Layer]; let photoBox:[Double]?; let surface:String?; let cards:[Card]? }
enum Failure:Error { case invalid,overflow }
func ink(_ s:String)->CGColor {let v=UInt32(s.dropFirst(),radix:16) ?? 0;return CGColor(red:CGFloat((v>>16)&255)/255,green:CGFloat((v>>8)&255)/255,blue:CGFloat(v&255)/255,alpha:1)}
func font(_ l:Layer)->CTFont {CTFontCreateWithName((l.fontWeight>=600 ? "PingFangSC-Semibold":"PingFangSC-Regular") as CFString,l.fontSize,nil)}
func rect(_ b:[Double],_ w:Double,_ h:Double)->CGRect {CGRect(x:b[0]*w,y:(1-b[1]-b[3])*h,width:b[2]*w,height:b[3]*h)}
func writePNG(_ im:CGImage,_ file:String)throws {guard let d=CGImageDestinationCreateWithURL(URL(fileURLWithPath:file) as CFURL,UTType.png.identifier as CFString,1,nil) else {throw Failure.invalid};CGImageDestinationAddImage(d,im,nil);guard CGImageDestinationFinalize(d) else {throw Failure.invalid}}
do {
 guard CommandLine.arguments.count==5 else {throw Failure.invalid}
 let input=CommandLine.arguments[1],spec=try JSONDecoder().decode(Spec.self,from:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[2]))),output=CommandLine.arguments[3],report=CommandLine.arguments[4]
 guard let src=CGImageSourceCreateWithURL(URL(fileURLWithPath:input) as CFURL,nil),let base=CGImageSourceCreateImageAtIndex(src,0,nil),base.width==spec.width,base.height==spec.height else {throw Failure.invalid}
 let w=Double(spec.width),h=Double(spec.height)
 if spec.mode=="analyze" {
  let n=64,scale=256,space=CGColorSpace(name:CGColorSpace.sRGB)!
  guard let ctx=CGContext(data:nil,width:scale,height:scale,bitsPerComponent:8,bytesPerRow:scale*4,space:space,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else {throw Failure.invalid}
  // Bitmap rows already follow the source's top-to-bottom scanline order.
  // Flipping this context inverted RGB/texture while Vision masks stayed upright.
  ctx.draw(base,in:CGRect(x:0,y:0,width:scale,height:scale))
  let pixels=ctx.data!.bindMemory(to:UInt8.self,capacity:scale*scale*4)
  let handler=VNImageRequestHandler(cgImage:base,options:[:]);var masked=[Bool](repeating:false,count:n*n),maskState="unavailable",protected=[[Double]]()
  if #available(macOS 14.0,*) {do{let req=VNGenerateForegroundInstanceMaskRequest();try handler.perform([req]);if let ob=req.results?.first,!ob.allInstances.isEmpty {let buffer=try ob.generateScaledMaskForImage(forInstances:ob.allInstances,from:handler);CVPixelBufferLockBaseAddress(buffer,.readOnly);defer{CVPixelBufferUnlockBaseAddress(buffer,.readOnly)};let mw=CVPixelBufferGetWidth(buffer),mh=CVPixelBufferGetHeight(buffer),stride=CVPixelBufferGetBytesPerRow(buffer),address=CVPixelBufferGetBaseAddress(buffer)!,format=CVPixelBufferGetPixelFormatType(buffer)
   for gy in 0..<n {for gx in 0..<n {var occupied=false;for sy in 0..<4 {for sx in 0..<4 {let x=min(mw-1,(gx*4+sx)*mw/(n*4)),y=min(mh-1,(gy*4+sy)*mh/(n*4));let row=address.advanced(by:y*stride);let value:Double=format==kCVPixelFormatType_OneComponent32Float ? Double(row.assumingMemoryBound(to:Float.self)[x]):Double(row.assumingMemoryBound(to:UInt8.self)[x])/255;if value>0.1 {occupied=true}}};masked[gy*n+gx]=occupied}}
   maskState="foreground-mask"}}catch{maskState="unavailable"}}
  do{let faces=VNDetectFaceRectanglesRequest();try handler.perform([faces]);for o in faces.results ?? [] {let b=o.boundingBox;protected.append([b.minX,1-b.maxY,b.width,b.height])}}catch{}
  do{let hands=VNDetectHumanHandPoseRequest();hands.maximumHandCount=6;try handler.perform([hands]);for o in hands.results ?? [] {let points=try o.recognizedPoints(.all).values.filter{$0.confidence>0.25};if points.count>2 {let xs=points.map{Double($0.location.x)},ys=points.map{Double($0.location.y)},x=xs.min()!,y=ys.min()!,mx=xs.max()!,my=ys.max()!;protected.append([x,1-my,mx-x,my-y])}}}catch{}
  var cells=[[Double]]();for gy in 0..<n {for gx in 0..<n {var sums=[Double](repeating:0,count:3),sq=0.0;for sy in 0..<4 {for sx in 0..<4 {let p=((gy*4+sy)*scale+gx*4+sx)*4;let r=Double(pixels[p]),g=Double(pixels[p+1]),b=Double(pixels[p+2]);sums[0]+=r;sums[1]+=g;sums[2]+=b;let l=(r+g+b)/3;sq+=l*l}};let avg=sums.map{$0/16},lum=avg.reduce(0,+)/3;cells.append(avg+[max(0,sq/16-lum*lum),masked[gy*n+gx] ? 1:0])}}
  let metrics=spec.layers.map{l->[String:Any] in
   let f=font(l),attributes:[NSAttributedString.Key:Any]=[NSAttributedString.Key(kCTFontAttributeName as String):f]
   let lines=l.text.components(separatedBy:"\n"),widths=lines.map{CTLineGetTypographicBounds(CTLineCreateWithAttributedString(NSAttributedString(string:$0,attributes:attributes)),nil,nil,nil)}
   let bounds=lines.map{line->[Double] in let b=CTLineGetBoundsWithOptions(CTLineCreateWithAttributedString(NSAttributedString(string:line,attributes:attributes)),[.useGlyphPathBounds]);return [b.minX,b.minY,b.width,b.height]}
   let lineHeight=CTFontGetAscent(f)+CTFontGetDescent(f)+CTFontGetLeading(f)
   var wraps=[[String:Any]]()
   if lines.count==1 {
    for extra in [0.008,0.043,0.078] {
     let fw=(widths[0]/w/2+extra)*w,fh=max(l.fontSize*1.1,lineHeight*1.05)*2
     var alignment:CTTextAlignment=l.align=="center" ? .center:l.align=="right" ? .right:.left
     let para=withUnsafePointer(to:&alignment){CTParagraphStyleCreate([CTParagraphStyleSetting(spec:.alignment,valueSize:MemoryLayout<CTTextAlignment>.size,value:$0)],1)}
     var attrs=attributes;attrs[NSAttributedString.Key(kCTParagraphStyleAttributeName as String)]=para
     let text=NSAttributedString(string:l.text,attributes:attrs),frame=CTFramesetterCreateFrame(CTFramesetterCreateWithAttributedString(text),CFRange(location:0,length:0),CGPath(rect:CGRect(x:0,y:0,width:fw,height:fh),transform:nil),nil)
     let frameLines=CTFrameGetLines(frame) as! [CTLine];var origins=[CGPoint](repeating:.zero,count:frameLines.count);CTFrameGetLineOrigins(frame,CFRange(location:0,length:0),&origins)
     let boxes=frameLines.enumerated().map{i,line->[Double] in let b=CTLineGetBoundsWithOptions(line,[.useGlyphPathBounds]),o=origins[i];return [(o.x+b.minX)/w,(fh-o.y-b.maxY)/h,b.width/w,b.height/h]}
     let lineTexts=frameLines.map{line->String in let r=CTLineGetStringRange(line);return (l.text as NSString).substring(with:NSRange(location:r.location,length:r.length))}
     wraps.append(["lineTexts":lineTexts,"width":fw/w,"height":fh/h,"complete":CTFrameGetVisibleStringRange(frame).length==text.length,"lineCount":frameLines.count,"inkBoxes":boxes])
    }
   }
   return ["text":l.text,"fontSize":l.fontSize,"widths":widths,"ascent":CTFontGetAscent(f),"inkBounds":bounds,"lineHeight":lineHeight,"wraps":wraps]
  }
  let data:[String:Any]=["version":"native-occupancy.1","grid":n,"cells":cells,"maskState":maskState,"protectedBoxes":protected,"metrics":metrics,"basis":"actual-base-pixels-and-local-Vision; not product identity verification"]
  try JSONSerialization.data(withJSONObject:data,options:[.sortedKeys]).write(to:URL(fileURLWithPath:report))
 } else {
  guard let ctx=CGContext(data:nil,width:spec.width,height:spec.height,bitsPerComponent:8,bytesPerRow:spec.width*4,space:CGColorSpace(name:CGColorSpace.sRGB)!,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else {throw Failure.invalid}
  ctx.setFillColor(ink(spec.surface ?? "#FFFFFF"));ctx.fill(CGRect(x:0,y:0,width:w,height:h));ctx.interpolationQuality = .high
  ctx.draw(base,in:rect(spec.photoBox ?? [0,0,1,1],w,h))
  for card in spec.cards ?? [] {let r=rect(card.box,w,h),path=CGPath(roundedRect:r,cornerWidth:12*w/1080,cornerHeight:12*w/1080,transform:nil);ctx.setFillColor(ink(card.color));ctx.addPath(path);ctx.fillPath();ctx.setStrokeColor(ink(card.ink).copy(alpha:0.14)!);ctx.setLineWidth(max(1,w/1080));ctx.addPath(path);ctx.strokePath();let s=min(r.height*0.5,w*0.055),cx=r.minX+w*0.035+s/2,cy=r.midY;ctx.setStrokeColor(ink(card.ink));ctx.setLineWidth(max(2,w/420));ctx.setLineCap(.round)
   switch card.icon {
   case "headband":for offset in [0.0,s*0.16] {ctx.addArc(center:CGPoint(x:cx,y:cy-s*0.25),radius:s*0.45-offset,startAngle:0,endAngle:Double.pi,clockwise:false);ctx.strokePath()}
   case "earpad":ctx.strokeEllipse(in:CGRect(x:cx-s*0.36,y:cy-s*0.5,width:s*0.72,height:s));ctx.strokeEllipse(in:CGRect(x:cx-s*0.20,y:cy-s*0.32,width:s*0.40,height:s*0.64))
   case "color":ctx.strokeEllipse(in:CGRect(x:cx-s/2,y:cy-s/2,width:s,height:s));ctx.move(to:CGPoint(x:cx-s*0.35,y:cy-s*0.35));ctx.addLine(to:CGPoint(x:cx+s*0.35,y:cy+s*0.35));ctx.strokePath()
   case "detail":ctx.strokeEllipse(in:CGRect(x:cx-s*0.4,y:cy-s*0.15,width:s*0.65,height:s*0.65));ctx.move(to:CGPoint(x:cx+s*0.1,y:cy-s*0.1));ctx.addLine(to:CGPoint(x:cx+s*0.45,y:cy-s*0.45));ctx.strokePath()
   default:ctx.setFillColor(ink(card.ink));ctx.fillEllipse(in:CGRect(x:cx-s*0.09,y:cy-s*0.09,width:s*0.18,height:s*0.18))
   }
  }
  guard let underlay=ctx.makeImage() else {throw Failure.invalid};try writePNG(underlay,report)
  for l in spec.layers {let r=rect(l.box,w,h);var alignment:CTTextAlignment=l.align=="center" ? .center:l.align=="right" ? .right:.left;let para=withUnsafePointer(to:&alignment){CTParagraphStyleCreate([CTParagraphStyleSetting(spec:.alignment,valueSize:MemoryLayout<CTTextAlignment>.size,value:$0)],1)};let text=NSAttributedString(string:l.text,attributes:[NSAttributedString.Key(kCTFontAttributeName as String):font(l),NSAttributedString.Key(kCTForegroundColorAttributeName as String):ink(l.color ?? "#28272b"),NSAttributedString.Key(kCTParagraphStyleAttributeName as String):para]);let setter=CTFramesetterCreateWithAttributedString(text),frame=CTFramesetterCreateFrame(setter,CFRange(location:0,length:0),CGPath(rect:r,transform:nil),nil);guard CTFrameGetVisibleStringRange(frame).length==text.length,(CTFrameGetLines(frame) as NSArray).count<=2 else {throw Failure.overflow};ctx.textMatrix = .identity;CTFrameDraw(frame,ctx)}
  guard let final=ctx.makeImage() else {throw Failure.invalid};try writePNG(final,output)
 }
}catch Failure.overflow{FileHandle.standardError.write(Data("TEXT_OVERFLOW".utf8));exit(3)}catch{FileHandle.standardError.write(Data("ADAPTIVE_COMPOSE_FAILED".utf8));exit(1)}
