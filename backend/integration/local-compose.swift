import Foundation
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers

// Local-only exact text compositor. Never uses a shell, network, or credentials.
struct Layer: Decodable {
    let text: String
    let box: [Double]
    let fontSize: Double
    let fontWeight: Int
    let align: String
    let color: String?
}
struct Spec: Decodable { let width: Int; let height: Int; let layers: [Layer] }
enum Failure: Error { case invalid, overflow }
do {
    guard CommandLine.arguments.count == 4 else { throw Failure.invalid }
    let spec = try JSONDecoder().decode(Spec.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2])))
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, nil),
          let base = CGImageSourceCreateImageAtIndex(source, 0, nil), base.width == spec.width, base.height == spec.height,
          let ctx = CGContext(data: nil, width: spec.width, height: spec.height, bitsPerComponent: 8, bytesPerRow: spec.width * 4,
                              space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw Failure.invalid }
    ctx.draw(base, in: CGRect(x: 0, y: 0, width: spec.width, height: spec.height))
    for layer in spec.layers {
        let b = layer.box, w = Double(spec.width), h = Double(spec.height)
        guard b.count == 4, !layer.text.isEmpty else { throw Failure.invalid }
        let rect = CGRect(x: b[0]*w, y: (1-b[1]-b[3])*h, width: b[2]*w, height: b[3]*h)
        let font = CTFontCreateWithName((layer.fontWeight >= 600 ? "PingFangSC-Semibold" : "PingFangSC-Regular") as CFString, layer.fontSize, nil)
        var alignment: CTTextAlignment = layer.align == "center" ? .center : layer.align == "right" ? .right : .left
        let paragraph = withUnsafePointer(to: &alignment) {
            CTParagraphStyleCreate([CTParagraphStyleSetting(spec: .alignment, valueSize: MemoryLayout<CTTextAlignment>.size, value: $0)], 1)
        }
        var ink = CGColor(red: 0.157, green: 0.153, blue: 0.169, alpha: 1)
        if let color = layer.color {
            guard color.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil,
                  let value = UInt32(color.dropFirst(), radix: 16) else { throw Failure.invalid }
            ink = CGColor(red: CGFloat((value >> 16) & 255)/255, green: CGFloat((value >> 8) & 255)/255, blue: CGFloat(value & 255)/255, alpha: 1)
        }
        let attrs: [NSAttributedString.Key: Any] = [NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): ink,
            NSAttributedString.Key(kCTParagraphStyleAttributeName as String): paragraph]
        let text = NSAttributedString(string: layer.text, attributes: attrs)
        let setter = CTFramesetterCreateWithAttributedString(text)
        let frame = CTFramesetterCreateFrame(setter, CFRange(location: 0, length: 0), CGPath(rect: rect, transform: nil), nil)
        let visible = CTFrameGetVisibleStringRange(frame)
        guard visible.length == text.length, (CTFrameGetLines(frame) as NSArray).count <= 2 else { throw Failure.overflow }
        ctx.textMatrix = .identity
        CTFrameDraw(frame, ctx)
    }
    guard let image = ctx.makeImage(), let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[3]) as CFURL, UTType.png.identifier as CFString, 1, nil) else { throw Failure.invalid }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { throw Failure.invalid }
} catch Failure.overflow {
    FileHandle.standardError.write(Data("TEXT_OVERFLOW".utf8)); exit(3)
} catch {
    FileHandle.standardError.write(Data("COMPOSE_FAILED".utf8)); exit(1)
}
