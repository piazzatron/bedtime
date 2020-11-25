import { h } from 'preact'
import { useCallback, useEffect, useState, useRef, useMemo } from 'preact/hooks'
import { getCollection, GetCollectionsResponse, getTrack, GetTracksResponse } from '../util/BedtimeClient'
import CollectionPlayerContainer from './collection/CollectionPlayerContainer'
import TrackPlayerContainer from './track/TrackPlayerContainer'
import Error from './error/Error'
import DeletedContent from './deleted/DeletedContent'
import cn from 'classnames'
import Loading from './loading/Loading'
import TwitterFooter from './twitterfooter/TwitterFooter'
import { ToastContextProvider } from './toast/ToastContext'
import { PauseContextProvider } from './pausedpopover/PauseProvider'
import PausePopover from './pausedpopover/PausePopover'

import styles from './App.module.css'
import { recordOpen, recordError } from '../analytics/analytics'
import transitions from './AppTransitions.module.css'
import { CSSTransition } from 'react-transition-group'
import { getDominantColor } from '../util/image/dominantColor'
import { shadeColor } from '../util/shadeColor'
import { isMobileWebTwitter } from '../util/isMobileWebTwitter'
import { CardContextProvider } from './card/Card'

if ((module).hot) {
    // tslint:disable-next-line:no-var-requires
    require('preact/debug')
}

// How long to wait for GA before we show the loading screen
const LOADING_WAIT_MSEC = 1

const RequestType = Object.seal({
  TRACK: 'track',
  COLLECTION: 'collection'
})

const pathComponentRequestTypeMap = {
  "playlist": RequestType.COLLECTION,
  "album": RequestType.COLLECTION,
  "track": RequestType.TRACK,
}

export const PlayerFlavor = Object.seal({
  CARD: 'card',
  COMPACT: 'compact'
})

// TWITCH CONSTANTS
const EBS_ENDPOINT = 'http://localhost:3000'

class Twitch {
  constructor() {
    this.token = null
    this.channelId = null
    this.clientId = null
    this.userId = null

    if (window.Twitch.ext) {
      this.twitch = window.Twitch.ext
    }
  }

  onAuthorized(authCallback) {
    if (!this.twitch) return

    const callback = (args) => {
      this.token = args.token
      this.channelId = args.channelId
      this.clientId = args.clientId
      this.userId = args.userId
      // wrap it
      authCallback(args)
    }

    this.twitch.onAuthorized(callback)
  }

  async getInitialTrack() {
    if (!(this.twitch && this.channelId && this.token)) return
    const endpoint = `${EBS_ENDPOINT}/channels/${this.channelId}/current_track`
    console.log(`Calling: ${endpoint}`)
    try {
      const res = await fetch(endpoint, {
        headers: this._getAuthHeader()
      })
      if (!res.ok) {
        throw new Error(res.statusText)
      }
      const json = await res.json()
      return json
    } catch (e) {
      console.error(e.message)
    }
  }

  async setTrack(trackId, ownerId) {
    console.log("Setting track!")
    if (!(this.twitch && this.channelId && this.token)) return
    const endpoint = `${EBS_ENDPOINT}/channels/${this.channelId}/current_track`
    const body = { trackId, ownerId }
    await fetch(endpoint, {
      method: "POST",
      headers: {
        ...this._getAuthHeader(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })
  }

  _getAuthHeader() {
    if (!this.token) return {}
    return {
      Authorization: `Bearer ${this.token}`
    }
  }
}

const TwitchContainer = () => {

  const twitch = useRef(new Twitch()).current

  const [isAuthed, setIsAuthed] = useState(false)
  useEffect(() => {
    console.log("Doing twitch stuff")
    twitch.onAuthorized((args) => {
      console.log("GOT AUTH")
      setIsAuthed(true)
    })
  }, [])

  const [initialTrack, setInitialTrack] = useState(null)
  useEffect(() => {
    const a = async () => {
      console.log("calling to get token")
      if (!isAuthed) return
      const token = twitch.token
      if (!token) return

      // returns {trackId, ownerId}
      const initialTrack = await twitch.getInitialTrack()
      setInitialTrack(initialTrack)
      console.log({initialTrack})
    }

    a()
  }, [isAuthed])

  const request = useMemo(() => {
    if (!initialTrack) return null

    const request = {
      requestType: RequestType.TRACK,
      playerFlavor: PlayerFlavor.COMPACT,
      id: initialTrack.trackId,
      ownerId: initialTrack.ownerId,
      isTwitter: false,
    }

    return request
  }, [initialTrack])


  useEffect(() => {
    setTimeout(() => {
      const a = async () => {
        await twitch.setTrack(74003, 201)
      }

      a()
    }, 5000)
  })
  return <App request={request}/>
}

// Attemps to parse a the window's url.
// Returns null if the URL scheme is invalid.
const getRequestDataFromURL = () => {
  const components = window.location.pathname.split('/')
  const lastComponent = components[components.length - 1]
  // Pull off the request type
  let requestType = pathComponentRequestTypeMap[lastComponent]
  if (!requestType) return null

  // Pull off the seach params
  const searchParams = new URLSearchParams(window.location.search)
  const [id, ownerId, flavor, isTwitter] = ['id', 'ownerId', 'flavor', 'twitter'].map(x => searchParams.get(x))

  // Validate the search params not null
  if ([id, ownerId, flavor].some(e => e === null)) {
    return null
  }
  // Parse them as ints
  const [intId, intOwnerId] = [parseInt(id), parseInt(ownerId)]
  if (isNaN(intId) || isNaN(intOwnerId)) {
    return null
  }

  // Get the flavor
  let playerFlavor
  if (flavor === PlayerFlavor.CARD) {
    playerFlavor = PlayerFlavor.CARD
  } else if (flavor === PlayerFlavor.COMPACT) {
    playerFlavor = PlayerFlavor.COMPACT
  } else {
    return null
  }

  return {
    requestType,
    playerFlavor,
    id: intId,
    ownerId: intOwnerId,
    isTwitter
  }
}

// type AppProps = {
//   request: {
//     requestType: RequestType,
//     id: number
//     ownerId: number
//     isTwitter: boolean
//   }
// }

const App = ({ request }) => {
  const [didError, setDidError] = useState(false) // General errors
  const [did404, setDid404] = useState(false) // 404s indicate content was deleted
  const [isRetrying, setIsRetrying] = useState(false) // Currently retrying?

  const [tracksResponse, setTracksResponse] = useState(null)
  const [collectionsResponse, setCollectionsResponse] = useState(null)
  const [showLoadingAnimation, setShowLoadingAnimation] = useState(true)
  const onGoingRequest = useRef(false)
  const [dominantColor, setDominantColor] = useState(null)

  useEffect(() => {
    if (didError) {
      recordError()
    }
  }, [didError])

  // TODO: pull these out into separate functions?
  // Request metadata from GA, computing
  // dominant color on success.
  const requestMetadata = useCallback(async (request) => {
    onGoingRequest.current = true

    // Queue up the loading animation
    setTimeout(() => {
      if (onGoingRequest.current) {
        setShowLoadingAnimation(true)
      }
    }, LOADING_WAIT_MSEC)

    try {
      if (request.requestType === RequestType.TRACK) {
        const track = await getTrack(request.id, request.ownerId)
        if (!track) {
          setDid404(true)
          setTracksResponse(null)
        } else {
          setDid404(false)
          setTracksResponse(track)
          recordOpen(track.id, track.title, track.handle, track.urlPath)

          // set average color
          const color = await getDominantColor(track.coverArt)
          setDominantColor({ primary: color })
        }
      } else {
        const collection = await getCollection(request.id, request.ownerId)
        if (!collection) {
          setDid404(true)
          setCollectionsResponse(null)
        } else {
          setDid404(false)
          setCollectionsResponse(collection)
          recordOpen(collection.id, collection.name, collection.ownerHandle, collection.collectionURLPath)

          // Set dominant color
          const color = await getDominantColor(collection.coverArt)
          setDominantColor({ primary: color, secondary: shadeColor(color, -20) })
        }
      }

      onGoingRequest.current = false
      setDidError(false)
      setShowLoadingAnimation(false)
    } catch (e) {
      onGoingRequest.current = false
      console.error(`Got error: ${e.message}`)
      setDidError(true)
      setShowLoadingAnimation(false)
      setDid404(false)
      setTracksResponse(null)
      setCollectionsResponse(null)
    }
  }, [])

  // Perform initial request
  useEffect(() => {
    if (request) {
      requestMetadata(request)
    }
  }, [request])

  // Retries
  const retryRequestMetadata = async () => {
    if (isRetrying) return
    setIsRetrying(true)
    // If we don't have a valid request state
    // (e.g. URL params are invalid, just wait and then set it to retry failed)

    // TODO: need to pass in a loading state or something
    // if (!requestState) {
    //   setTimeout(() => {
    //     setIsRetrying(false)
    //   }, 1500)
    //   return
    // }

    await requestMetadata(request)
    setIsRetrying(false)
  }

  const isCompact = request && request.playerFlavor && request.playerFlavor === PlayerFlavor.COMPACT
  const mobileWebTwitter = isMobileWebTwitter(request?.isTwitter)

  // The idea is to show nothing (null) until either we
  // get metadata back from GA, or we pass the loading threshold
  // and display the loading screen.
  const renderPlayerContainer = () => {
    if (didError) {
      return (
        <Error
          onRetry={retryRequestMetadata}
          isRetrying={isRetrying}
        />
      )
    }

    if (did404) {
      return (
        <DeletedContent
          isCard={!isCompact}
        />
      )
    }

    if (showLoadingAnimation) {
      return <Loading />
    }

    const mobileWebTwitter = isMobileWebTwitter(request?.isTwitter)

    if (request && dominantColor) {
      return (
        <CSSTransition
          classNames={{
            appear: mobileWebTwitter ? transitions.appearMobileWebTwitter : transitions.appear,
            appearActive: mobileWebTwitter ? transitions.appearActiveMobileWebTwitter : transitions.appearActive
          }}
          appear
          in
          timeout={1000}
        >
        { tracksResponse
          ? <TrackPlayerContainer
              track={tracksResponse}
              flavor={request.playerFlavor}
              isTwitter={request.isTwitter}
              backgroundColor={dominantColor.primary}
            />
          : <CollectionPlayerContainer
              collection={collectionsResponse}
              flavor={request.playerFlavor}
              isTwitter={request.isTwitter}
              backgroundColor={dominantColor.primary}
              rowBackgroundColor={dominantColor.secondary}
            />
        }
        </CSSTransition>
      )
    }

    return null
  }

  const renderPausePopover = () => {
    if (!request || (!tracksResponse && !collectionsResponse)) {
      return null
    }

    let artworkURL = tracksResponse?.coverArt || collectionsResponse?.coverArt
    let artworkClickURL = tracksResponse?.urlPath || collectionsResponse?.collectionURLPath
    let listenOnAudiusURL = tracksResponse?.urlPath || collectionsResponse?.collectionURLPath
    let flavor = request.playerFlavor
    return (<PausePopover
             artworkURL={artworkURL}
             artworkClickURL={artworkClickURL}
             listenOnAudiusURL={listenOnAudiusURL}
             flavor={flavor}
             isMobileWebTwitter={mobileWebTwitter}
            />)
  }

  useEffect(() => {
    if (request?.isTwitter) {
      document.body.style.backgroundColor = '#ffffff'
    }
  }, [request])

  return (
    <div
      id='app'
      className={
        cn(styles.app,
           { [styles.compactApp]: isCompact },
           { [styles.twitter]: request && request.isTwitter && !mobileWebTwitter}
          )}>
      <ToastContextProvider>
        <PauseContextProvider>
          <CardContextProvider>
            {renderPausePopover()}
            {renderPlayerContainer()}
          </CardContextProvider>
        </PauseContextProvider>
      </ToastContextProvider>
    </div>
  )
}

export default TwitchContainer
