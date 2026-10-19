import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count > 1 else { FileHandle.standardError.write("usage: ocr <image>\n".data(using:.utf8)!); exit(1) }
let url = URL(fileURLWithPath: args[1])
guard let img = NSImage(contentsOf: url),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("cannot load image\n".data(using:.utf8)!); exit(1)
}
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = true
req.recognitionLanguages = ["en-US"]
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do { try handler.perform([req]) } catch { FileHandle.standardError.write("ocr fail\n".data(using:.utf8)!); exit(1) }
var out = ""
if let obs = req.results {
    for o in obs {
        if let c = o.topCandidates(1).first { out += c.string + "\n" }
    }
}
print(out)
