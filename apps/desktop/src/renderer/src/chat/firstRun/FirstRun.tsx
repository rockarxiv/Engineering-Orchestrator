import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { ipcQuery } from "../../query/client";
import { firstRunKey } from "../../query/hooks";
import { Button, Card, Field, TextInput, ViewHeader } from "../kit";
import { StandaloneScreen } from "../standalone";
import { Gallery } from "../views/gallery/GalleryView";

/**
 * First run, in the order the design settled (EO-317,
 * the original design).
 *
 * "Mode, then gallery, then optional Preview with no sign-in, then the
 * template's own blanks as a short form, then the needs check with a
 * 'why' line per red item and 'Continue with Preview only', then the
 * first real item."
 *
 * What this component owns is step 1 and the frame; steps 2 to 6 are the
 * gallery, which is the same screen a person reaches from Templates
 * afterwards. That is deliberate and is the whole reason first run is
 * not a wizard of its own: a second project starts from a template as
 * much as a first does, and a flow that existed only at the beginning
 * would be a screen nobody could return to — and a second copy of the
 * needs check to keep in step with this one.
 *
 * **It replaces "point EO at a repository"**, which was the wrong door
 * for everybody who is not a developer, and is now one card in the
 * gallery for the developers it was right for.
 *
 * Drawn in the chat layout's look whichever layout the window is set to
 * (EO-527): the chat kit, on a `StandaloneScreen` in this device's chat
 * theme. The gallery is the chat layout's own (`views/gallery`), so the
 * flow and the Templates view are still the one screen.
 */
export function FirstRun({ onLeft }: { onLeft: () => void }) {
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: firstRunKey, queryFn: () => ipcQuery("firstRun:state", undefined) });

  const finish = useMutation({
    mutationFn: () => ipcQuery("firstRun:finish", undefined),
    // Everything on screen is about to be about a project that did not
    // exist a moment ago.
    onSuccess: () => void queryClient.invalidateQueries(),
  });

  /**
   * Both exits come through here: the first item, and "Continue with
   * Preview only".
   *
   * The gate is told first and told directly, rather than being left to
   * notice: `firstRun:finish` is a round trip, and the screen the person
   * pressed the button on navigates immediately. Waiting for the answer
   * would put the flow back over the board for as long as the write
   * took.
   */
  const leave = () => {
    onLeft();
    finish.mutate();
  };

  // Nothing is drawn until the mode is known, because drawing step 1
  // first and then replacing it would ask somebody a question they had
  // already answered.
  if (state.isLoading) return null;
  if ((state.data?.mode ?? null) === null) return <Mode onAnswered={() => void queryClient.invalidateQueries({ queryKey: firstRunKey })} />;
  return (
    // From the top rather than centred: the cards, the form and the needs
    // check all run longer than a window, and the ground scrolls.
    <StandaloneScreen width="max-w-6xl" centred={false}>
      <Gallery onFinished={leave} />
    </StandaloneScreen>
  );
}

/**
 * Step 1: "one question before anything else — solo or organisation."
 *
 * Solo goes straight in. Organisation is where a server is, and until
 * EO-323 there was none: EO took the address and said plainly that
 * signing in was not available in this version, because a control that
 * did nothing is what invariant #12 rules out.
 *
 * There is one now, and this step says where it is rather than claiming
 * to be it. Signing in needs an invitation from whoever runs that server
 * — an address alone cannot get anybody in — so a form here would be a
 * password field in front of somebody who does not have a password yet.
 * The address is still kept, and Settings → Organisation is where they
 * go once the link arrives. The same rule, one release on: an absence is
 * never left to be discovered, and neither is a presence.
 */
function Mode({ onAnswered }: { onAnswered: () => void }) {
  const [organisation, setOrganisation] = useState(false);
  const [address, setAddress] = useState("");

  const answer = useMutation({
    mutationFn: (mode: "solo" | "organisation") => ipcQuery("firstRun:setMode", { mode, address }),
    onSuccess: onAnswered,
  });

  return (
    <StandaloneScreen>
      <ViewHeader
        icon={<Sparkles size={15} />}
        title="Welcome to EO"
        meta="EO runs work through a pipeline: agents do the steps that can be done for you, and you decide the ones that are yours. One question before anything else."
      />

      <Card>
        {organisation ? (
          <>
            <Field label="Your organisation's EO address" hint="Something like eo.acme.com.">
              <TextInput aria-label="Your organisation's EO address" value={address} onChange={(event) => setAddress(event.target.value)} />
            </Field>
            {/* Said before anything is typed into it, not after. */}
            <p className="text-[12.5px] leading-relaxed text-ink-muted">
              EO keeps the address. Ask whoever runs that server to invite you, then open Settings → Organisation and sign in with the link
              they send — everything below works on this machine on its own in the meantime.
            </p>
            <div className="flex items-center gap-2">
              <Button variant="primary" disabled={answer.isPending} onClick={() => answer.mutate("organisation")}>
                Carry on
              </Button>
              <Button variant="ghost" onClick={() => setOrganisation(false)}>
                Back
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-[13.5px] text-ink">Is this just you, or is it for an organisation?</p>
            <div className="flex items-center gap-2">
              <Button variant="primary" disabled={answer.isPending} onClick={() => answer.mutate("solo")}>
                Just me
              </Button>
              <Button onClick={() => setOrganisation(true)}>My organisation</Button>
            </div>
            <p className="text-[12.5px] leading-relaxed text-ink-subtle">
              Just me keeps everything on this machine: your projects, your sign-ins, your folders. An organisation shares pipelines and
              agents through a server.
            </p>
          </>
        )}
      </Card>
    </StandaloneScreen>
  );
}
