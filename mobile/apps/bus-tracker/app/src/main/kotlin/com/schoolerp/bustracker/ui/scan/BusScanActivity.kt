package com.schoolerp.bustracker.ui.scan

import com.journeyapps.barcodescanner.CaptureActivity
import com.journeyapps.barcodescanner.DecoratedBarcodeView
import com.schoolerp.bustracker.R

/*
The scan screen for a bus sticker, in the app's own clothes.

   ZXing's CaptureActivity is fine machinery wearing a stock layout; all this
   does is hand it our layout instead, the one whose viewfinder is the bright
   PhonePe-style window (PhonePeViewfinderView). Everything else -- the camera
   lifecycle, the permission prompt, returning the decoded contents -- is the
   library's and is left untouched by overriding the one seam it exposes for
   exactly this.
*/
class BusScanActivity : CaptureActivity() {
    override fun initializeContent(): DecoratedBarcodeView {
        setContentView(R.layout.scanner_phonepe)
        return findViewById(R.id.zxing_barcode_scanner)
    }
}
