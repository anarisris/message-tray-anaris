/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

const Clutter = imports.gi.Clutter;
const Gtk = imports.gi.Gtk;
const Lang = imports.lang;
const Meta = imports.gi.Meta;
const Signals = imports.signals;
const Shell = imports.gi.Shell;

const Main = imports.ui.main;
const Params = imports.misc.params;

// GrabHelper:
// @owner: the actor that owns the GrabHelper
//
// Creates a new GrabHelper object, for dealing with keyboard and pointer
// grabs associated with a set of actors.
//
// Note that the grab can be automatically dropped at any time, and your
// code just needs to deal with it. Connect to the 'ungrabbed' signal to
// know when the grab has been dropped by the user. This may happen at
// any time; see the documentation of the grab() method for details.
const GrabHelper = new Lang.Class({
    Name: 'GrabHelper',

    _init: function(owner) {
        this._owner = owner;

        this._grabStack = [];

        this._actors = [];
        this._capturedEventId = 0;
        this._eventId = 0;
        this._keyFocusNotifyId = 0;
        this._focusWindowChangedId = 0;
        this._ignoreRelease = false;

        this._modalCount = 0;
    },

    // addActor:
    // @actor: an actor
    //
    // Adds @actor to the set of actors that are allowed to process events
    // during a grab.
    addActor: function(actor) {
        actor.__grabHelperDestroyId = actor.connect('destroy', Lang.bind(this, function() { this.removeActor(actor); }));
        this._actors.push(actor);
    },

    // removeActor:
    // @actor: an actor
    //
    // Removes @actor from the set of actors that are allowed to
    // process events during a grab.
    removeActor: function(actor) {
        let index = this._actors.indexOf(actor);
        if (index != -1)
            this._actors.splice(index, 1);
        if (actor.__grabHelperDestroyId) {
            actor.disconnect(actor.__grabHelperDestroyId);
            delete actor.__grabHelperDestroyId;
        }
    },

    _isWithinGrabbedActor: function(actor) {
        while (actor) {
            if (this._actors.indexOf(actor) != -1)
                return true;
            actor = actor.get_parent();
        }
        return false;
    },

    get grabbed() {
        return this._grabStack.length > 0;
    },

    get currentGrab() {
        return this._grabStack[this._grabStack.length - 1] || {}
    },

    _isActorGrabbed: function(actor) {
        if (!actor)
            return false;

        for (let i = 0; i < this._grabStack.length; i++) {
            if (this._grabStack[i].actor === actor)
                return true;
        }
        return false;
    },

    // grab:
    // @params: A bunch of parameters, see below
    //
    // Grabs the mouse and keyboard, according to the GrabHelper's
    // parameters. If @newFocus is not %null, then the keyboard focus
    // is moved to the first #StWidget:can-focus widget inside it.
    //
    // The grab will automatically be dropped if:
    //   - The user clicks outside the grabbed actors
    //   - The user types Escape
    //   - The keyboard focus is moved outside the grabbed actors
    //   - A window is focused
    //
    // If @params.actor is not null, then it will be focused as the
    // new actor. If you attempt to grab an already focused actor, the
    // request to be focused will be ignored. The actor will not be
    // added to the grab stack, so do not call ungrab().
    //
    // If @params contains { modal: true }, then grab() will push a modal
    // on the owner of the GrabHelper. As long as there is at least one
    // { modal: true } actor on the grab stack, the grab will be kept.
    // When the last { modal: true } actor is ungrabbed, then the modal
    // will be dropped.
    //
    // If @params contains { grabFocus: true }, then if you call grab()
    // while the shell is outside the overview, it will set the stage
    // input mode to %Shell.StageInputMode.FOCUSED, and ungrab() will
    // revert it back, and re-focus the previously-focused window (if
    // another window hasn't been explicitly focused before then).
    //
    //
    grab: function(params) {
        params = Params.parse(params, { focus: true,
                                        actor: null,
                                        modal: false,
                                        grabFocus: false });

        let focus = global.stage.key_focus;
        let hadFocus = focus && this._isWithinGrabbedActor(focus);
        let newFocus = hadFocus ? focus : params.actor;

        if (this._isActorGrabbed(params.actor))
            return newFocus;

        if (!this.grabbed)
            this._fullGrab(focus, hadFocus, params.modal, params.grabFocus);

        this._grabStack.push(params);

        if (params.modal)
            this._modalCount++;

        if (params.focus === false) {
            newFocus = hadFocus ? focus : newFocus;
            if (newFocus) {
                if (!newFocus.navigate_focus(null, Gtk.DirectionType.TAB_FORWARD, false))
                    newFocus.grab_key_focus();
            }
        }

        return newFocus;
    },

    _fullGrab: function(focus, hadFocus, modal, grabFocus) {
        let metaDisplay = global.screen.get_display();

        this._grabbedFromKeynav = hadFocus;
        this._preGrabInputMode = global.stage_input_mode;
        this._prevFocusedWindow = null;

        if (modal) {
            Main.pushModal(this._owner);
            if (hadFocus)
                focus.grab_key_focus();
        }

        if (grabFocus) {
            this._prevFocusedWindow = metaDisplay.focus_window;
            if (this._preGrabInputMode == Shell.StageInputMode.NONREACTIVE ||
                this._preGrabInputMode == Shell.StageInputMode.NORMAL) {
                global.set_stage_input_mode(Shell.StageInputMode.FOCUSED);
            }
        }

        this._capturedEventId = global.stage.connect('captured-event', Lang.bind(this, this._onCapturedEvent));
        this._eventId = global.stage.connect('event', Lang.bind(this, this._onEvent));
        this._keyFocusNotifyId = global.stage.connect('notify::key-focus', Lang.bind(this, this._onKeyFocusChanged));
        this._focusWindowChangedId = metaDisplay.connect('notify::focus-window', Lang.bind(this, this._focusWindowChanged));
    },

    // ignoreRelease:
    //
    // Make sure that the next button release event evaluated by the
    // capture event handler returns false. This is designed for things
    // like the ComboBoxMenu that go away on press, but need to eat
    // the next release event.
    ignoreRelease: function() {
        this._ignoreRelease = true;
    },

    // ungrab:
    // @params: The parameters for the grab; see below.
    //
    // Pops an actor from the grab stack, potentially dropping the grab.
    //
    // Normally, the keyboard focus will be reverted to the previous actor on
    // the grab stack. However, if @params contains 'actor', that is not %null,
    // then the focus will be set to @newFocus after releasing the grab. (This
    // allows you to ensure that the keynav focus reverts to the expected
    // location, which may not be the same actor as it was on before the grab.)
    //
    // This function will emit an 'ungrabbed' signal, containing the parameters
    // passed into grab(), and whether the cause of the ungrab was a user action.
    // This is determined by the 'userAction' property of @params. All ungrabs
    // performed automatically by the GrabHelper have the 'userAction' property
    // set to 'true'.
    //
    // The intended way of using the GrabHelper is to connect to the 'ungrabbed'
    // signal, and do all tweening and cleanup based on that, leaving calls to
    // ungrab() bare, without any state tracking.
    ungrab: function(params) {
        params = Params.parse(params, { userAction: false,
                                        actor: null });

        let poppedGrab = this.currentGrab;
        let { modal: modal, actor: actor } = poppedGrab;

        if (!this.grabbed)
            return {};

        if (params.actor && (params.actor != actor))
            return {};

        this._grabStack.pop();

        let newFocus = this.currentGrab.actor;
        if (newFocus) {
            if (!newFocus.navigate_focus(null, Gtk.DirectionType.TAB_FORWARD, false))
                newFocus.grab_key_focus();
        }

        this.emit('ungrabbed', poppedGrab, params.userAction);

        if (!this.grabbed)
            this._fullUngrab(newFocus);

        if (modal)
            this._modalCount--;

        return poppedGrab;
    },

    _fullUngrab: function(newFocus) {
        global.stage.disconnect(this._capturedEventId);
        this._capturedEventId = 0;
        global.stage.disconnect(this._eventId);
        this._eventId = 0;
        global.stage.disconnect(this._keyFocusNotifyId);
        this._keyFocusNotifyId = 0;
        let metaDisplay = global.screen.get_display();
        metaDisplay.disconnect(this._focusWindowChangedId);
        this._focusWindowChangedId = 0;

        let focus = global.stage.key_focus;
        let hadFocus = focus && this._isWithinGrabbedActor(focus);
        let prePopInputMode = global.stage_input_mode;

        if (this._modalCount > 0) {
            Main.popModal(this._owner);
            global.sync_pointer();
        }

        if (this._grabbedFromKeynav) {
            if (this._preGrabInputMode == Shell.StageInputMode.FOCUSED &&
                prePopInputMode != Shell.StageInputMode.FULLSCREEN)
                global.set_stage_input_mode(Shell.StageInputMode.FOCUSED);
            if (hadFocus && newFocus)
                newFocus.grab_key_focus();
        }

        if (this._prevFocusedWindow) {
            let metaDisplay = global.screen.get_display();
            if (!metaDisplay.focus_window) {
                metaDisplay.set_input_focus_window(this._prevFocusedWindow,
                                                   false, global.get_current_time());
            }
        }
    },

    _onCapturedEvent: function(actor, event) {
        let type = event.type();
        let press = type == Clutter.EventType.BUTTON_PRESS;
        let release = type == Clutter.EventType.BUTTON_RELEASE;
        let button = press || release;

        if (release && this._ignoreRelease) {
            this._ignoreReleas = false;
            return false;
        }

        if (!button && this._modalCount == 0)
            return false;

        if (this._isWithinGrabbedActor(event.get_source()))
            return false;

        if (button) {
            // If we have a press event, ignore the next event,
            // which should be a release event.
            if (press)
                this._ignoreRelease = true;
            this.ungrab({ userAction: true });
        }

        return this._modalCount > 0;
    },

    // We catch 'event' rather than 'key-press-event' so that we get
    // a chance to run before the overview's own Escape check
    _onEvent: function(actor, event) {
        if (event.type() == Clutter.EventType.KEY_PRESS &&
            event.get_key_symbol() == Clutter.KEY_Escape) {
            this.ungrab({ userAction: true });
            return true;
        }

        return false;
    },

    _onKeyFocusChanged: function() {
        let focus = global.stage.key_focus;
        if (!focus || !this._isWithinGrabbedActor(focus))
            this.ungrab({ userAction: true });
    },

    _focusWindowChanged: function() {
        let metaDisplay = global.screen.get_display();
        if (metaDisplay.focus_window != null)
            this.ungrab({ userAction: true });
    }
});
Signals.addSignalMethods(GrabHelper.prototype);
