import Foundation
import Vision
// Local-only OCR. Text is source material; it is never executed as instructions.
do {
    guard CommandLine.arguments.count == 2 else { exit(2) }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = false
    let handler = VNImageRequestHandler(url: URL(fileURLWithPath: CommandLine.arguments[1]), options: [:])
    try handler.perform([request])
    let rows: [[String: Any]] = (request.results ?? []).compactMap { observation in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let box = observation.boundingBox
        return ["text": candidate.string, "confidence": candidate.confidence,
                "box": [box.minX, 1 - box.maxY, box.width, box.height]]
    }
    let data = try JSONSerialization.data(withJSONObject: rows)
    FileHandle.standardOutput.write(data)
} catch {
    // No file paths or system diagnostics in the public error response.
    FileHandle.standardError.write(Data("Local text recognition failed".utf8)); exit(1)
}
