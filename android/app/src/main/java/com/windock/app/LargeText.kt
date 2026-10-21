package com.windock.app

import android.content.Context
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Space

/**
 * Spec 9.3: above a font scale of 1.3 the two-column landscape screens (Computers,
 * pairing, problem screens) become one scrolling column, as on iOS: the rail or left
 * column first, the right column below it. Resource qualifiers cannot select on font
 * scale, so the existing layouts are restacked in code when a screen is inflated.
 */
object LargeText {
    const val STACK_ABOVE = 1.3f

    fun stacks(fontScale: Float): Boolean = fontScale > STACK_ABOVE

    fun stacks(context: Context): Boolean = stacks(context.resources.configuration.fontScale)

    /** A column width from the layout: the full width once stacked. */
    fun columnWidth(context: Context, px: Int): Int = if (stacks(context)) ViewGroup.LayoutParams.MATCH_PARENT else px

    /**
     * Restack the horizontal LinearLayout [columnsId] inside [root] into one column wrapped
     * in a ScrollView. Returns the view the screen should show (a new ScrollView when the
     * columns are the root itself).
     */
    fun stack(root: View, columnsId: Int): View {
        val context = root.context
        val columns = (if (root.id == columnsId) root else root.findViewById(columnsId)) as? LinearLayout ?: return root
        val d = { v: Float -> Ui.dp(context, v).toInt() }
        columns.orientation = LinearLayout.VERTICAL
        columns.gravity = Gravity.TOP or Gravity.START
        for (i in 0 until columns.childCount) {
            val child = columns.getChildAt(i)
            (child.layoutParams as? LinearLayout.LayoutParams)?.let { lp ->
                lp.width = ViewGroup.LayoutParams.MATCH_PARENT
                lp.height = ViewGroup.LayoutParams.WRAP_CONTENT
                lp.weight = 0f
                if (i > 0) { lp.marginStart = 0; lp.topMargin = d(28f) }
                child.layoutParams = lp
            }
            flatten(child, d(20f))
        }
        // The column scrolls as a whole; its top padding (room for a top bar) stays fixed.
        val scroll = ScrollView(context).apply {
            id = View.generateViewId()
            isFillViewport = true
            isVerticalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
            clipToPadding = true
            setPadding(0, columns.paddingTop, 0, 0)
        }
        columns.setPadding(columns.paddingLeft, 0, columns.paddingRight, columns.paddingBottom)
        val parent = columns.parent as? ViewGroup
        if (parent == null) {
            scroll.addView(columns, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            return scroll
        }
        val index = parent.indexOfChild(columns)
        val lp = columns.layoutParams
        parent.removeViewAt(index)
        scroll.addView(columns, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        parent.addView(scroll, index, lp)
        return root
    }

    /**
     * Inside a column: weighted spacers get a fixed gap, filling heights wrap, and nested
     * scroll views grow to their content (the outer ScrollView scrolls instead).
     */
    private fun flatten(view: View, gap: Int) {
        val lp = view.layoutParams
        if (view is Space && lp is LinearLayout.LayoutParams && lp.weight > 0f) {
            lp.weight = 0f
            lp.height = gap
            view.layoutParams = lp
            return
        }
        if (view is ScrollView) {
            view.isFillViewport = false
            lp?.height = ViewGroup.LayoutParams.WRAP_CONTENT
            view.layoutParams = lp
        }
        if (view is ViewGroup) {
            if (view is LinearLayout && view.orientation == LinearLayout.VERTICAL && lp != null &&
                lp.height == ViewGroup.LayoutParams.MATCH_PARENT) {
                lp.height = ViewGroup.LayoutParams.WRAP_CONTENT
                view.layoutParams = lp
            }
            if (view is FrameLayout && lp != null && lp.height == ViewGroup.LayoutParams.MATCH_PARENT) {
                lp.height = ViewGroup.LayoutParams.WRAP_CONTENT
                view.layoutParams = lp
            }
            for (i in 0 until view.childCount) flatten(view.getChildAt(i), gap)
        }
    }
}
